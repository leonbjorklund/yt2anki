import { defineConfig } from "@playwright/test";
import sharedConfig from "./playwright.config.mjs";

// The only config that reaches the live caption gate. Run it through
// `pnpm test:e2e:caption-gate` alone; it is not a routine or CI check.
export default defineConfig({
  ...sharedConfig,
  maxFailures: 1,
  testIgnore: [],
  testMatch: /caption-gate\.spec\.js$/u,
});
