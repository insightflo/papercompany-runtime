import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/antigravity-local",
      "packages/adapters/pi-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
