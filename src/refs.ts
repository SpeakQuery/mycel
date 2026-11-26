import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { walkStrings } from "./secrets.js";

export type Taint = "trusted" | "untrusted";

export interface RefMeta {
  id: string; // ref://<24 hex>
  hash: string;
  mime: string;
  size: number;
  name?: string;
  createdAt: string;
  source?: { server?: string; tool?: string; agent?: string };
  taint: Taint;
  digest: Digest;
}

export type Digest =
  | { kind: "json"; shape: unknown; length?: number; sample: unknown }
  | { kind: "table"; columns: string[]; rows: number; sample: string[][]; stats: Record<string, { min: number; max: number; mean: number }> }
  | { kind: "text"; chars: number; lines: number; outline: string[]; head: string; tail: string }
  | { kind: "image"; width?: number; height?: number; format?: string }
  | { kind: "video"; durationSec?: number; width?: number; height?: number; fps?: number; codec?: string; hasAudio?: boolean; keyframes: string[] }
  | { kind: "audio"; durationSec?: number; sampleRate?: number; channels?: number; codec?: string }
  | { kind: "binary"; magic: string };

const REF_RE = /^ref:\/\/([a-f0-9]{24})$/;

export function isRefId(v: unknown): v is string {
  return typeof v === "string" && REF_RE.test(v);
}

/**
 * Content-addressed store for large or binary data. Tools pass `ref://…` handles
 * between each other; the model only ever sees a compact digest.
 */
export class RefStore {
  readonly dir: string;
  private hasFfprobe: boolean | null = null;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "objects"), { recursive: true });
  }

  private paths(id: string) {
    const h = id.replace("ref://", "");
    const d = join(this.dir, "objects", h.slice(0, 2));
    return { d, data: join(d, h), meta: join(d, `${h}.json`) };
  }

  put(data: Buffer | string, opts: { mime?: string; name?: string; source?: RefMeta["source"]; taint?: Taint } = {}): RefMeta {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hash = createHash("sha256").update(buf).digest("hex");
    const id = `ref://${hash.slice(0, 24)}`;
    const p = this.paths(id);
    if (existsSync(p.meta)) {
      const prev = JSON.parse(readFileSync(p.meta, "utf8")) as RefMeta;
      // A ref is as tainted as its most-tainted origin.
      if (opts.taint === "untrusted" && prev.taint !== "untrusted") {
        prev.taint = "untrusted";
        writeFileSync(p.meta, JSON.stringify(prev, null, 2));
      }
      return prev;
    }
    mkdirSync(p.d, { recursive: true });
    writeFileSync(p.data, buf);
    const mime = opts.mime ?? sniffMime(buf, opts.name);
    const meta: RefMeta = {
      id,
      hash,
      mime,
      size: buf.length,
      name: opts.name,
      createdAt: new Date().toISOString(),
      source: opts.source,
      taint: opts.taint ?? "trusted",
      digest: { kind: "binary", magic: "" },
    };
    meta.digest = this.digest(buf, mime, p.data);
    writeFileSync(p.meta, JSON.stringify(meta, null, 2));
    return meta;
  }

  putJson(value: unknown, opts: Parameters<RefStore["put"]>[1] = {}) {
    return this.put(JSON.stringify(value, null, 2), { ...opts, mime: "application/json" });
  }

  has(id: string) {
    return isRefId(id) && existsSync(this.paths(id).meta);
  }

  meta(id: string): RefMeta {
    if (!this.has(id)) throw new Error(`Unknown ref ${id}`);
    return JSON.parse(readFileSync(this.paths(id).meta, "utf8"));
  }

  get(id: string): Buffer {
    if (!this.has(id)) throw new Error(`Unknown ref ${id}`);
    return readFileSync(this.paths(id).data);
  }

  path(id: string): string {
    if (!this.has(id)) throw new Error(`Unknown ref ${id}`);
    return this.paths(id).data;
  }

  /** Read a slice of a ref: byte/char range, JSON path, or table rows. */
  read(id: string, opts: { offset?: number; length?: number; path?: string; rows?: [number, number]; grep?: string } = {}): unknown {
    const meta = this.meta(id);
    const buf = this.get(id);
    if (meta.mime === "application/json" && (opts.path !== undefined || opts.grep === undefined)) {
      const v = JSON.parse(buf.toString("utf8"));
      const sel = opts.path ? jsonPath(v, opts.path) : v;
      if (opts.rows && Array.isArray(sel)) return sel.slice(opts.rows[0], opts.rows[1]);
      return sel;
    }
    if (isTextual(meta.mime)) {
      const text = buf.toString("utf8");
      if (opts.grep) {
        const re = new RegExp(opts.grep, "i");
        return text
          .split(/\r?\n/)
          .map((l, i) => [i + 1, l] as const)
          .filter(([, l]) => re.test(l))
          .slice(0, 200)
          .map(([n, l]) => `${n}: ${l}`)
          .join("\n");
      }
      if (opts.rows) return text.split(/\r?\n/).slice(opts.rows[0], opts.rows[1]).join("\n");
      const offset = opts.offset ?? 0;
      return text.slice(offset, offset + (opts.length ?? 4000));
    }
    const offset = opts.offset ?? 0;
    return buf.subarray(offset, offset + (opts.length ?? 3000)).toString("base64");
  }

  list(limit = 100): RefMeta[] {
    const out: RefMeta[] = [];
    const root = join(this.dir, "objects");
    if (!existsSync(root)) return out;
    for (const d of readdirSync(root)) {
      for (const f of readdirSync(join(root, d))) {
        if (f.endsWith(".json")) out.push(JSON.parse(readFileSync(join(root, d, f), "utf8")));
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Delete refs older than `maxAgeMs` (garbage collection). */
  gc(maxAgeMs: number): number {
    let n = 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const m of this.list(Number.MAX_SAFE_INTEGER)) {
      if (Date.parse(m.createdAt) < cutoff) {
        const p = this.paths(m.id);
        rmSync(p.data, { force: true });
        rmSync(p.meta, { force: true });
        n++;
      }
    }
    return n;
  }

  /** What the model sees in place of the data. */
  handle(meta: RefMeta) {
    return {
      ref: meta.id,
      mime: meta.mime,
      size: humanBytes(meta.size),
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.taint === "untrusted" ? { taint: "untrusted" } : {}),
      digest: meta.digest,
      hint: "Pass this ref to any tool argument (as a string, or {\"$ref\": id, \"as\": \"text|json|base64|path|dataUrl\"}) or read slices with mycel_ref.",
    };
  }

  /**
   * Replace refs inside tool arguments with real content before calling upstream.
   * - "ref://…" string → text content (JSON is parsed if the ref is JSON)
   * - {"$ref": "ref://…", "as": "text|json|base64|path|dataUrl"} → that representation
   * Returns the taint of any ref used, so the trust layer can reason about it.
   */
  resolveArgs<T>(args: T): { args: T; refs: RefMeta[] } {
    const used: RefMeta[] = [];
    const resolveOne = (id: string, as?: string): unknown => {
      const meta = this.meta(id);
      used.push(meta);
      const buf = this.get(id);
      switch (as) {
        case "path":
          return this.path(id);
        case "base64":
          return buf.toString("base64");
        case "dataUrl":
          return `data:${meta.mime};base64,${buf.toString("base64")}`;
        case "json":
          return JSON.parse(buf.toString("utf8"));
        case "text":
          return buf.toString("utf8");
        default:
          if (meta.mime === "application/json") return JSON.parse(buf.toString("utf8"));
          return isTextual(meta.mime) ? buf.toString("utf8") : buf.toString("base64");
      }
    };
    const walk = (v: unknown): unknown => {
      if (isRefId(v)) return resolveOne(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (isRefId(o.$ref) && Object.keys(o).every((k) => k === "$ref" || k === "as")) return resolveOne(o.$ref, o.as as string | undefined);
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return { args: walk(args) as T, refs: used };
  }

  // ---------------------------------------------------------------- digests
  private digest(buf: Buffer, mime: string, file: string): Digest {
    try {
      if (mime === "application/json") return jsonDigest(JSON.parse(buf.toString("utf8")));
      if (mime === "text/csv" || mime === "text/tab-separated-values") return tableDigest(buf.toString("utf8"), mime === "text/csv" ? "," : "\t");
      if (isTextual(mime)) return textDigest(buf.toString("utf8"));
      if (mime.startsWith("image/")) return { kind: "image", ...this.probe(file, "image") };
      if (mime.startsWith("video/")) return this.videoDigest(file);
      if (mime.startsWith("audio/")) return { kind: "audio", ...this.probe(file, "audio") };
    } catch {
      /* fall through to binary */
    }
    return { kind: "binary", magic: buf.subarray(0, 8).toString("hex") };
  }

  private ffprobe(): boolean {
    if (this.hasFfprobe === null) {
      try {
        execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
        this.hasFfprobe = true;
      } catch {
        this.hasFfprobe = false;
      }
    }
    return this.hasFfprobe;
  }

  private probe(file: string, _kind: string): Record<string, number | string | boolean | undefined> {
    if (!this.ffprobe()) return {};
    const out = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out) as { streams?: Array<Record<string, string | number>>; format?: Record<string, string> };
    const v = j.streams?.find((s) => s.codec_type === "video");
    const a = j.streams?.find((s) => s.codec_type === "audio");
    const fps = v?.r_frame_rate ? String(v.r_frame_rate).split("/").map(Number) : undefined;
    return {
      durationSec: j.format?.duration ? Math.round(Number(j.format.duration) * 100) / 100 : undefined,
      width: v ? Number(v.width) : undefined,
      height: v ? Number(v.height) : undefined,
      fps: fps && fps[1] ? Math.round((fps[0] / fps[1]) * 100) / 100 : undefined,
      codec: String((v ?? a)?.codec_name ?? j.format?.format_name ?? ""),
      format: j.format?.format_name,
      hasAudio: !!a,
      sampleRate: a ? Number(a.sample_rate) : undefined,
      channels: a ? Number(a.channels) : undefined,
    };
  }

  /** Video digest: metadata plus 3 keyframes stored as their own image refs. */
  private videoDigest(file: string): Digest {
    const info = this.probe(file, "video");
    const keyframes: string[] = [];
    const dur = Number(info.durationSec ?? 0);
    if (this.ffprobe() && dur > 0) {
      for (const t of [0.1, 0.5, 0.9]) {
        try {
          const jpg = execFileSync(
            "ffmpeg",
            ["-v", "error", "-ss", String(dur * t), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
            { timeout: 15000, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
          );
          if (jpg.length) keyframes.push(this.put(jpg, { mime: "image/jpeg", name: `keyframe@${Math.round(dur * t * 10) / 10}s.jpg` }).id);
        } catch {
          /* keyframes are best-effort */
        }
      }
    }
    return {
      kind: "video",
      durationSec: info.durationSec as number | undefined,
      width: info.width as number | undefined,
      height: info.height as number | undefined,
      fps: info.fps as number | undefined,
      codec: info.codec as string | undefined,
      hasAudio: info.hasAudio as boolean | undefined,
      keyframes,
    };
  }
}

// ------------------------------------------------------------------ helpers
export function isTextual(mime: string) {
  return mime.startsWith("text/") || /json|xml|yaml|javascript|csv|markdown|html|svg/.test(mime);
}

export function sniffMime(buf: Buffer, name?: string): string {
  const ext = name?.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values", md: "text/markdown", txt: "text/plain",
    html: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
  };
  if (ext && byExt[ext]) return byExt[ext];
  const h = buf.subarray(0, 12);
  if (h[0] === 0x89 && h[1] === 0x50) return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8) return "image/jpeg";
  if (h.subarray(0, 4).toString() === "GIF8") return "image/gif";
  if (h.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (h.subarray(0, 4).toString("hex") === "1a45dfa3") return "video/webm";
  if (h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WAVE") return "audio/wav";
  if (h.subarray(0, 3).toString() === "ID3") return "audio/mpeg";
  if (h.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  const text = buf.subarray(0, 2048).toString("utf8");
  if (/�/.test(text) || /[\x00-\x08\x0E-\x1F]/.test(text)) return "application/octet-stream";
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(buf.toString("utf8"));
      return "application/json";
    } catch {
      /* not json */
    }
  }
  const lines = text.split(/\r?\n/).slice(0, 5).filter(Boolean);
  if (lines.length >= 2) {
    const c = lines.map((l) => l.split(",").length);
    if (c[0] > 1 && c.every((n) => n === c[0])) return "text/csv";
  }
  return "text/plain";
}

function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 3) return "object";
    const entries = Object.entries(v as object).slice(0, 25);
    return Object.fromEntries(entries.map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

function truncate(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 120 ? v.slice(0, 117) + "…" : v;
  if (Array.isArray(v)) return depth > 2 ? `[${v.length} items]` : v.slice(0, 3).map((x) => truncate(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(v as object).slice(0, 12).map(([k, x]) => [k, truncate(x, depth + 1)]));
  }
  return v;
}

export function jsonDigest(v: unknown): Digest {
  return { kind: "json", shape: shapeOf(v), length: Array.isArray(v) ? v.length : undefined, sample: truncate(v) };
}

function textDigest(s: string): Digest {
  const lines = s.split(/\r?\n/);
  const outline = lines.filter((l) => /^#{1,3}\s/.test(l) || /^[A-Z][A-Z0-9 ]{4,60}:?$/.test(l.trim())).slice(0, 20);
  return { kind: "text", chars: s.length, lines: lines.length, outline, head: s.slice(0, 600), tail: s.length > 800 ? s.slice(-200) : "" };
}

function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function tableDigest(s: string, sep: string): Digest {
  const lines = s.split(/\r?\n/).filter((l) => l.length);
  const columns = splitRow(lines[0] ?? "", sep);
  const rows = lines.slice(1).map((l) => splitRow(l, sep));
  const stats: Record<string, { min: number; max: number; mean: number }> = {};
  columns.forEach((c, i) => {
    const nums = rows.map((r) => Number(r[i])).filter((n) => r_isNum(n));
    if (nums.length && nums.length >= rows.length * 0.8) {
      stats[c] = {
        min: Math.min(...nums),
        max: Math.max(...nums),
        mean: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100,
      };
    }
  });
  return { kind: "table", columns, rows: rows.length, sample: rows.slice(0, 5), stats };
}
function r_isNum(n: number) {
  return Number.isFinite(n);
}

export function jsonPath(v: unknown, path: string): unknown {
  // Supports: $.a.b[0].c, a.b.0, $.items[*].name
  const parts = path.replace(/^\$\.?/, "").match(/[^.[\]]+|\[\*\]/g) ?? [];
  let cur: unknown[] = [v];
  for (const p of parts) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (p === "[*]" || p === "*") {
        if (Array.isArray(c)) next.push(...c);
        else if (c && typeof c === "object") next.push(...Object.values(c));
      } else if (c && typeof c === "object") next.push((c as Record<string, unknown>)[p]);
    }
    cur = next;
  }
  return path.includes("*") ? cur : cur[0];
}

export function humanBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    try {
      const s = statSync(join(dir, f));
      if (s.isFile()) total += s.size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

export { walkStrings };
