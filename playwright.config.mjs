import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  reporter: "line",
  testDir: "./e2e",
  // The live caption gate reaches real YouTube, so it runs only through
  // playwright.caption-gate.config.mjs.
  testIgnore: /caption-gate\.spec\.js$/u,
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
  workers: 1,
});
