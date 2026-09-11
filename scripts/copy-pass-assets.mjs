import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tsc only emits .ts files, and rootDir is src, so the .pass model directory has to be
// copied into dist explicitly. cpSync is used rather than `cp -R` so the build works on
// any platform.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "src/wallet/providers/apple/model");
const target = resolve(projectRoot, "dist/wallet/providers/apple/model");

if (!existsSync(source)) {
  throw new Error(`Pass model assets are missing at ${source}`);
}

cpSync(source, target, { recursive: true });
