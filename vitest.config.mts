import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // An array so the wallet branch's certificate setup can be added alongside this
    // one without either branch having to edit the other's file.
    globalSetup: ["tests/db-global-setup.ts"],
    testTimeout: 20_000,
    restoreMocks: true
  }
});
