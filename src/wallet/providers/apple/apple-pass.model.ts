import path from "node:path";

const MODEL_DIRECTORY_NAME = "voone-loyalty.pass";

/**
 * Resolved relative to the compiled file, not the working directory, so the path is correct
 * under both `tsx watch src/server.ts` and `node dist/server.js` — the model directory sits
 * beside this module in `src/` and is copied to the same place in `dist/` by the build. A
 * PaaS does not guarantee the working directory, so `cwd` is deliberately not used.
 *
 * The directory name already ends in `.pass`, which matters: passkit-generator only appends
 * that suffix when the given path has no extension.
 */
export const resolvePassModelDirectory = (override?: string): string =>
  override ? path.resolve(override) : path.join(__dirname, "model", MODEL_DIRECTORY_NAME);
