import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/shared",
      "packages/adapter-utils",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/antigravity-local",
      "packages/adapters/pi-local",
      "packages/adapters/commandcode-local",
      "packages/adapters/openclaw-gateway",
      "server",
      "ui",
      "cli",
    ],
  },
});
