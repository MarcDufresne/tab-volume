import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const { version } = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const out = path.join(ROOT, "dist", `tab-volume-${version}.zip`);

mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", "-q", out, ".", "-x", ".*", "-x", "*/.*"], { cwd: EXT });
console.log(`${out} (${statSync(out).size} bytes)`);
