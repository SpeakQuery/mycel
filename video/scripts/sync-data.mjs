// Copies video/data.json into assets/data.js so every scene can read the numbers
// without a network fetch (HyperFrames renders must be deterministic and offline).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
writeFileSync(
  join(root, "assets", "data.js"),
  "// GENERATED from data.json by scripts/sync-data.mjs. Edit data.json, not this file.\n" +
    "window.MYCEL_DATA = " + JSON.stringify(data, null, 2) + ";\n",
);
console.log("data.json -> assets/data.js (" + Object.keys(data).length + " keys)");
