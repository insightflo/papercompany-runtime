import { defineConfig } from "@playwright/test";

// Task 6D 전용 격리 브라우저 설정. 전역 E2E 설정(tests/e2e)을 편집하지 않는다.
// Vite가 실제 UI 소스를 127.0.0.1:5279 로 제공하고, 모든 /api 요청은 fixtures.ts가
// 가로채므로 백엔드(3200)로 단 하나의 요청도 나가지 않는다.
export default defineConfig({
  testDir: ".",
  testMatch: "dialog.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5279",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm --filter @paperclipai/ui exec vite --host 127.0.0.1 --port 5279 --strictPort",
    url: "http://127.0.0.1:5279",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
