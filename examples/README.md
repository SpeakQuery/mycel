# Examples

Everything here runs from a clone. Build once at the repo root (`npm install && npm run build`); the
examples import `../../dist/index.js` directly, so nothing needs to be published.

| Folder | What | Start with |
|---|---|---|
| [`demo/`](demo) | One scripted, verified end-to-end tour: tokens, search, code mode, refs, video jobs, taint, budget, capability tokens, A2A, recorder | `node examples/demo/run-demo.mjs` |
| [`quickstart/`](quickstart) | `mycel.yaml` wiring four mock servers with policy, budget and contracts, plus CLI walkthrough | `cd examples/quickstart && node ../../dist/cli.js doctor -c mycel.yaml` |
| [`full-scale/`](full-scale) | Reproduces the 15-server / 420-tool context footprint (~204k direct vs ~1.2k through Mycel) from captured `tools/list` dumps, no network | `cd examples/full-scale && npm test` |
| [`servers/`](servers) | Mock MCP servers built with `defineAdapter().serve()`: GitHub, AI media studio, web + email, warehouse | used by the configs above |
| [`a2a/`](a2a) | Two Mycel instances: a planner delegating to a builder over A2A with capability tokens | `examples/a2a/README.md` |
| [`adapters/`](adapters) | ~60-line template for wrapping a hosted video model API | `examples/adapters/README.md` |
| [`clients/`](clients) | Claude Desktop, Cursor, VS Code and Claude Code snippets | copy-paste |

Requirements: Node ≥ 20; `ffmpeg` for the video parts (`brew install ffmpeg` / `apt install ffmpeg`).
