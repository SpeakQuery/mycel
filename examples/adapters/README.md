# Adapter template: a hosted video model

`replicate-style-video.mjs` (~60 lines) shows how to wrap a hosted text-to-video API that uses the common
"create a prediction, poll until done, download the output" pattern. **It is a template.** By default it
points at `https://video-api.example.invalid` (a domain that never resolves) and refuses to run until you set
`VIDEO_API_URL`. It does not call any real or paid service.

What it demonstrates:
- `async: true` → Mycel runs the tool as a job (progress, cancel via `AbortSignal`, retries, fallback)
- `costUsd` → shown in search results; enforce it in `mycel.yaml` (`servers.video.tools.text_to_video.costUsd`)
- `progress(done, total, message)` while polling
- `file(bytes, "video/mp4")` → Mycel stores the MP4 as a `ref://` with a video digest and keyframes
- the same definition as a stdio MCP server (`node replicate-style-video.mjs`) or in-process (`adapter.provider`)

## Try it without a provider

```bash
npm run build      # repo root, once
cat > /tmp/video.yaml <<YAML
servers:
  video:
    command: node
    args: ["$PWD/examples/adapters/replicate-style-video.mjs"]
YAML
node dist/cli.js doctor -c /tmp/video.yaml | grep video         #  ✓ video: 1 tools
node dist/cli.js call video.text_to_video '{"prompt":"x"}' -c /tmp/video.yaml
```
```json
{ "status": "job", "tool": "video.text_to_video",
  "job": { "id": "job_…", "status": "failed", "error": "Set VIDEO_API_URL (and VIDEO_API_TOKEN) to use this template." } }
```

## Use it for real

1. Adapt the request body and response fields (`status`, `progress`, `output`) to your provider's API docs.
2. Add it to `mycel.yaml`, with the token kept in the secret vault:
   ```yaml
   servers:
     video:
       command: node
       args: ["examples/adapters/replicate-style-video.mjs"]
       env: { VIDEO_API_URL: "https://api.your-provider.example/v1", VIDEO_API_TOKEN: "{{secret:VIDEO_API_TOKEN}}" }
       tools:
         text_to_video: { async: true, costUsd: 0.35, retries: 1, fallback: ["studio.generate_video"] }
   ```
3. `export VIDEO_API_TOKEN=…` and `mycel doctor`.

The polling loop was tested against a local fake API that serves a ffmpeg-generated MP4. The result was a
`video/mp4` ref with a 2 s, 320×180 h264 digest, 3 keyframes and a $0.35 charge.
