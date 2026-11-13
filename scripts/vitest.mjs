// Runs Vitest with a normalised working directory. On Windows, a lowercase
// drive letter in cwd ("c:\...", as VS Code terminals often have) makes Vitest
// load its runner twice and every suite fails with "reading 'config'".
import { spawnSync } from "node:child_process";
import path from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(r.status ?? 1);
