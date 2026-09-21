/**
 * passkit-generator ships ESM-flavoured type declarations next to a CommonJS runtime build:
 * its `lib/types` directory has no `package.json`, so the package root's `"type": "module"`
 * applies to the declarations. Under this project's CommonJS + `module: Node16` setup a
 * static import is therefore a TS1479 error, even though `require()` resolves correctly at
 * runtime.
 *
 * The module is loaded dynamically instead — TypeScript preserves `import()` as a real
 * dynamic import in CommonJS output under `module: Node16`, so this works under both
 * `tsx watch src/server.ts` and `node dist/server.js` — and its types are referenced with an
 * explicit resolution mode. Every other file imports from here, so the workaround lives in
 * exactly one place.
 */
// The import attribute must be an inline literal, and must stay on one line.
// prettier-ignore
export type PasskitModule = typeof import("passkit-generator", { with: { "resolution-mode": "import" } });

export type PKPassInstance = InstanceType<PasskitModule["PKPass"]>;

/** A single pass field entry, derived from the library rather than restated. */
export type PassField = PKPassInstance["primaryFields"][number];

let cached: PasskitModule | undefined;

export const loadPasskit = async (): Promise<PasskitModule> => {
  cached ??= await import("passkit-generator");

  return cached;
};
