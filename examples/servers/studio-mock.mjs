#!/usr/bin/env node
// A mock AI media studio MCP server (stdio).
//  - generate_image  → a real PNG gradient, encoded in pure JS (zlib only)
//  - generate_video  → long-running (progress 0..100 over ~6 s), a real MP4 rendered by ffmpeg
//  - upscale_video   → takes a video (pass a ref:// from generate_video), returns a 2x MP4
//  - estimate_cost   → read-only price quote
import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineAdapter, file } from "../../dist/index.js";

const run = promisify(execFile);
const PRICES = { generate_image: 0.04, generate_video: 0.4, upscale_video: 0.1 };

// ---------------------------------------------------------------- PNG (no deps)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function gradientPng(width, height, from, to) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1) + y / (height - 1)) / 2;
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Deterministic colours from the prompt, so the same prompt gives the same image.
const hue = (s, salt) => {
  let h = 2166136261 ^ salt;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
};

// ---------------------------------------------------------------- ffmpeg helpers
async function hasFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}
const NO_FFMPEG = "ffmpeg is not installed or not on PATH. Install it (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg) to generate videos.";

async function encode(args, out) {
  // Prefer H.264; fall back to MPEG-4 part 2 for minimal ffmpeg builds.
  try {
    await run("ffmpeg", ["-v", "error", "-y", ...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  } catch {
    await run("ffmpeg", ["-v", "error", "-y", ...args, "-c:v", "mpeg4", "-q:v", "4", out]);
  }
}

/** Report progress 0..100 over `ms` while `work` runs; resolves with work's value. */
async function withProgress(ctx, ms, work, label) {
  let p = 0;
  const step = 100 / (ms / 300);
  ctx.progress(0, 100, `${label}: queued`);
  const timer = setInterval(() => {
    p = Math.min(99, p + step);
    ctx.progress(Math.round(p), 100, `${label}: ${p < 30 ? "denoising" : p < 70 ? "rendering frames" : "encoding"}`);
  }, 300);
  const minTime = new Promise((r) => setTimeout(r, ms));
  try {
    const [value] = await Promise.all([work(), minTime]);
    if (ctx.signal?.aborted) throw new Error("cancelled");
    ctx.progress(100, 100, `${label}: done`);
    return value;
  } finally {
    clearInterval(timer);
  }
}

defineAdapter({
  name: "studio-mock",
  tools: [
    {
      name: "generate_image",
      description: "Generate an image from a text prompt. Returns a PNG.",
      effect: "write",
      costUsd: PRICES.generate_image,
      input: { type: "object", properties: { prompt: { type: "string" }, width: { type: "integer", maximum: 1024 }, height: { type: "integer", maximum: 1024 } }, required: ["prompt"] },
      run: async ({ prompt, width = 256, height = 160 }) => file(gradientPng(Math.min(width, 1024), Math.min(height, 1024), hue(prompt, 1), hue(prompt, 2)), "image/png", "image.png"),
    },
    {
      name: "generate_video",
      description: "Make a short video clip from a text prompt (text-to-video). Returns an MP4.",
      effect: "write",
      async: true,
      costUsd: PRICES.generate_video,
      input: { type: "object", properties: { prompt: { type: "string" }, seconds: { type: "number", minimum: 1, maximum: 10 } }, required: ["prompt"] },
      run: async ({ prompt, seconds = 4 }, ctx) => {
        if (!(await hasFfmpeg())) throw new Error(NO_FFMPEG);
        const dir = mkdtempSync(join(tmpdir(), "studio-"));
        const out = join(dir, "clip.mp4");
        try {
          await withProgress(ctx, 6000, () => encode(["-f", "lavfi", "-i", `testsrc2=duration=${Math.min(Number(seconds) || 4, 10)}:size=640x360:rate=24`], out), `video "${String(prompt).slice(0, 40)}"`);
          return file(readFileSync(out), "video/mp4", "clip.mp4");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "upscale_video",
      description: "Upscale a video 2x. `video` accepts a ref:// handle (Mycel resolves it to the bytes) or a file path.",
      effect: "write",
      async: true,
      costUsd: PRICES.upscale_video,
      input: { type: "object", properties: { video: { type: "string", description: "ref:// handle, base64 MP4, or file path" } }, required: ["video"] },
      run: async ({ video }, ctx) => {
        if (!(await hasFfmpeg())) throw new Error(NO_FFMPEG);
        if (typeof video !== "string" || !video) throw new Error("video is required");
        const dir = mkdtempSync(join(tmpdir(), "studio-"));
        try {
          let input = video;
          if (!existsSync(video)) {
            // A ref:// passed as a plain string arrives as base64 bytes.
            input = join(dir, "in.mp4");
            writeFileSync(input, Buffer.from(video, "base64"));
          }
          const out = join(dir, "upscaled.mp4");
          await withProgress(ctx, 1500, () => encode(["-i", input, "-vf", "scale=iw*2:ih*2:flags=lanczos"], out), "upscale");
          return file(readFileSync(out), "video/mp4", "upscaled.mp4");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "estimate_cost",
      description: "Quote the price of a studio operation before running it.",
      effect: "read",
      input: { type: "object", properties: { tool: { type: "string", enum: Object.keys(PRICES) }, count: { type: "integer", minimum: 1 } }, required: ["tool"] },
      run: async ({ tool, count = 1 }) => {
        if (!(tool in PRICES)) throw new Error(`Unknown studio tool ${tool}`);
        return { tool, count, unitUsd: PRICES[tool], totalUsd: Math.round(PRICES[tool] * count * 100) / 100 };
      },
    },
  ],
}).serve();
