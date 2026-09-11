import { createHash } from "node:crypto";

import { unzipSync } from "fflate";

export type PkpassEntries = Record<string, Uint8Array>;

/** do-not-zip writes STORED entries only, which any pure-JS reader handles. */
export const readPkpass = (buffer: Buffer): PkpassEntries => unzipSync(new Uint8Array(buffer));

export const sha1 = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

export const entryText = (entries: PkpassEntries, name: string): string =>
  Buffer.from(entries[name]).toString("utf8");

export const readPassJson = (entries: PkpassEntries): Record<string, unknown> =>
  JSON.parse(entryText(entries, "pass.json")) as Record<string, unknown>;

export const readManifest = (entries: PkpassEntries): Record<string, string> =>
  JSON.parse(entryText(entries, "manifest.json")) as Record<string, string>;
