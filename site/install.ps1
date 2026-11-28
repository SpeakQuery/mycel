# Mycel installer for Windows (PowerShell).
#   irm https://mycel.speakquery.ai/install.ps1 | iex
#
# What it does, without administrator rights:
#   1. Uses your Node.js 20+ if you have one; otherwise downloads the official Node.js 22 zip from nodejs.org,
#      checks its SHA-256 against nodejs.org's SHASUMS256.txt and unpacks it into %USERPROFILE%\.mycel\node.
#   2. Installs @speakquery/mycel into %USERPROFILE%\.mycel\app (a private copy).
#   3. Starts the setup wizard. It shows what it will change and asks before doing anything; `mycel undo` reverts.
$ErrorActionPreference = "Stop"
$MycelDir = if ($env:MYCEL_HOME) { $env:MYCEL_HOME } else { Join-Path $HOME ".mycel" }
$NodeDir = Join-Path $MycelDir "node"
$AppDir = Join-Path $MycelDir "app"

function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }
function NodeOk($exe) {
  try { & $exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" 2>$null; return $LASTEXITCODE -eq 0 } catch { return $false }
}

Write-Host "`n  Mycel installer`n"
$Node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and (NodeOk $sys.Source)) {
  $Node = $sys.Source; Say "OK Node.js $(& $Node -v) found"
} elseif ((Test-Path (Join-Path $NodeDir "node.exe")) -and (NodeOk (Join-Path $NodeDir "node.exe"))) {
  $Node = Join-Path $NodeDir "node.exe"; Say "OK Node.js $(& $Node -v) found in $NodeDir"
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  Say "Node.js 20+ was not found. Downloading the official Node.js 22 for win-$arch (about 30 MB)..."
  $base = "https://nodejs.org/dist/latest-v22.x"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mycel-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1
    if (-not $line) { Fail "no Node.js build for win-$arch" }
    $want, $file = ($line.Trim() -split "\s+")
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($got -ne $want.ToLower()) { Fail "checksum mismatch for $file; nothing was installed" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    Copy-Item -Path (Join-Path $tmp ($file -replace "\.zip$", "") | Join-Path -ChildPath "*") -Destination $NodeDir -Recurse -Force
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  $Node = Join-Path $NodeDir "node.exe"
  Say "OK Node.js $(& $Node -v) installed in $NodeDir (checksum verified)"
}

$npm = Join-Path (Split-Path $Node) "npm.cmd"
if (-not (Test-Path $npm)) { $c = Get-Command npm -ErrorAction SilentlyContinue; if ($c) { $npm = $c.Source } else { Fail "npm was not found next to Node.js" } }
Say "Installing Mycel into $AppDir..."
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$env:PATH = (Split-Path $Node) + ";" + $env:PATH
& $npm install --prefix $AppDir --no-fund --no-audit --loglevel=error "@speakquery/mycel@latest" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
$cli = Join-Path $AppDir "node_modules\@speakquery\mycel\dist\cli.js"
if (-not (Test-Path $cli)) { Fail "Mycel was not installed correctly" }
Say "OK Mycel $(& $Node $cli --version) installed"

# A `mycel` command for later (mycel stats, mycel undo, mycel doctor).
$BinDir = Join-Path $MycelDir "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Set-Content -Path (Join-Path $BinDir "mycel.cmd") -Value "@echo off`r`n`"$Node`" `"$cli`" %*" -Encoding ASCII
if (-not (Get-Command mycel -ErrorAction SilentlyContinue)) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($userPath -split ";" | Where-Object { $_ -eq $BinDir })) {
    $a = Read-Host "  Add the mycel command to your terminal (your user PATH)? [Y/n]"
    if ($a -notmatch "^(n|no|hayir)$") {
      [Environment]::SetEnvironmentVariable("Path", ($BinDir + ";" + $userPath).TrimEnd(";"), "User")
      Say "OK mycel command added (new terminal windows will have it)"
    } else { Say "OK. You can always run: $BinDir\mycel.cmd" }
  }
}
$env:MYCEL_ENTRY_ABSOLUTE = "1"
& $Node $cli setup @args
