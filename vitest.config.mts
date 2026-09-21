import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // An array so the wallet branch's certificate setup runs alongside the database
    // one without either having to edit the other's file.
    globalSetup: ["tests/db-global-setup.ts", "tests/global-setup.ts"],
    testTimeout: 20_000,
    restoreMocks: true
  }
});
