#!/usr/bin/env node
// TEMPLATE: wrap a hosted text-to-video API (Replicate-style "create prediction, then poll")
// as an MCP tool. Nothing here talks to a real service until you point VIDEO_API_URL at one.
//
//   VIDEO_API_URL=https://api.your-provider.example/v1  VIDEO_API_TOKEN=…  node replicate-style-video.mjs
//
// mycel.yaml:
//   servers:
//     video:
//       command: node
//       args: ["examples/adapters/replicate-style-video.mjs"]
//       env: { VIDEO_API_URL: "https://…", VIDEO_API_TOKEN: "{{secret:VIDEO_API_TOKEN}}" }
//       tools: { text_to_video: { async: true, costUsd: 0.35, retries: 1, fallback: ["studio.generate_video"] } }
import { pathToFileURL } from "node:url";
import { defineAdapter, file } from "../../dist/index.js";

const BASE = process.env.VIDEO_API_URL ?? "https://video-api.example.invalid/v1"; // placeholder, never resolves
const headers = () => ({ authorization: `Bearer ${process.env.VIDEO_API_TOKEN ?? ""}`, "content-type": "application/json" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const adapter = defineAdapter({
  name: "hosted-video",
  tools: [
    {
      name: "text_to_video",
      description: "Generate a video from a text prompt with a hosted model. Returns an MP4.",
      effect: "write",
      async: true, // Mycel runs it as a job: progress, cancel, retries, fallback
      costUsd: 0.35, // shown to the model; enforce it via servers.<name>.tools in mycel.yaml
      input: { type: "object", properties: { prompt: { type: "string" }, seconds: { type: "integer", minimum: 1, maximum: 10 }, aspect: { type: "string", enum: ["16:9", "9:16", "1:1"] } }, required: ["prompt"] },
      async run({ prompt, seconds = 5, aspect = "16:9" }, { progress, signal }) {
        if (!process.env.VIDEO_API_URL) throw new Error("Set VIDEO_API_URL (and VIDEO_API_TOKEN) to use this template.");
        let p = await api("/predictions", { method: "POST", body: JSON.stringify({ input: { prompt, seconds, aspect_ratio: aspect } }), signal });
        while (!["succeeded", "failed", "canceled"].includes(p.status)) {
          if (signal?.aborted) {
            await api(`/predictions/${p.id}/cancel`, { method: "POST" }).catch(() => {});
            throw new Error("cancelled");
          }
          progress(Math.round((p.progress ?? 0) * 100), 100, p.status);
          await sleep(2000);
          p = await api(`/predictions/${p.id}`, { signal });
        }
        if (p.status !== "succeeded") throw new Error(`prediction ${p.id} ${p.status}: ${p.error ?? "no details"}`);
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        const bytes = Buffer.from(await (await fetch(url, { signal })).arrayBuffer());
        return file(bytes, "video/mp4", `${p.id}.mp4`); // Mycel stores it as a ref with a video digest
      },
    },
  ],
});

export default adapter; // in-process: new Mycel(loaded, { providers: { video: { provider: adapter.provider } } })
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) adapter.serve(); // stdio MCP server
