#!/bin/sh
# Point Formula/mycel.rb at the latest @speakquery/mycel on npm. Prints the new version, or nothing if unchanged.
set -eu
latest=$(curl -fsSL https://registry.npmjs.org/@speakquery%2fmycel/latest | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n1)
current=$(sed -n 's|.*mycel-\([0-9][^"]*\)\.tgz".*|\1|p' Formula/mycel.rb)
[ -n "$latest" ] && [ "$latest" != "$current" ] || exit 0
url="https://registry.npmjs.org/@speakquery/mycel/-/mycel-$latest.tgz"
sha=$(curl -fsSL "$url" | shasum -a 256 | cut -d ' ' -f 1)
sed -i.bak -e "s|mycel-$current\.tgz|mycel-$latest.tgz|" -e "s|sha256 \"[0-9a-f]*\"|sha256 \"$sha\"|" Formula/mycel.rb && rm Formula/mycel.rb.bak
echo "$latest"
