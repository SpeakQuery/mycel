# How Mycel is distributed (and why you can trust where it comes from)

| Channel | Command / link | Where it comes from | How it is checked |
|---|---|---|---|
| Claude Desktop extension | [GitHub Releases → mycel.mcpb](https://github.com/SpeakQuery/mycel/releases/latest/download/mycel.mcpb) | built by GitHub Actions from this repository's tag | `SHA256SUMS` in the same release |
| Homebrew (macOS, Linux) | `brew tap speakquery/mycel https://github.com/SpeakQuery/mycel && brew install mycel` | the npm package below | formula pins the npm tarball's SHA-256 |
| npm | `npx -y @speakquery/mycel setup` | npm registry | npm provenance (once trusted publishing is on, see below) |
| Installer | `curl -fsSL https://mycel.speakquery.ai/install.sh \| sh` · `irm https://mycel.speakquery.ai/install.ps1 \| iex` | this repository (`site/`), also attached to each GitHub Release | Node.js from nodejs.org checked against its SHA256SUMS; script checksums in the release |

## Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: unit tests, the end-to-end test, the extension build, a GitHub Release with `mycel.mcpb`, both installers and `SHA256SUMS`, then `npm publish --provenance`. The Homebrew formula follows npm releases on its own (`.github/workflows/brew.yml`, hourly).

## One-time settings that need the npm / Anthropic account owner

1. **npm trusted publishing** (so releases need no password or security key): npmjs.com → package `@speakquery/mycel` → Settings → Trusted publishing → GitHub Actions; organization or user `SpeakQuery`, repository `mycel`, workflow `release.yml`. After this, every tag publishes to npm with a provenance badge.
2. **Claude Desktop extension directory** (one-click install from Claude's own Settings → Extensions, the most trusted path for non-technical users): submit the extension through Anthropic's directory submission form with:
   - bundle: the `mycel.mcpb` from the latest GitHub Release
   - privacy policy: https://mycel.speakquery.ai/privacy.html
   - source: https://github.com/SpeakQuery/mycel (Apache-2.0)
   - what it does: puts the user's MCP servers behind a few meta-tools; `mycel_setup` shows a plan and changes app settings only after the user says yes, with backups and undo
   - network: only the MCP servers the user connects, plus a daily version check on registry.npmjs.org
