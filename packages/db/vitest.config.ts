import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // [hook-budget] embedded-PG teardown 패턴이 server 샤드 실패와 동일 — hook 예산만 확장.
    hookTimeout: 60_000,
  },
});
