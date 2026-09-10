import { defineConfig } from "vitest/config";

// Opt-in REAL-producer integration suite ONLY — never loaded by `pnpm test` / `pnpm test:run`
// (their project discovery excludes tests/external, and *.external.ts does not match default
// include globs). Run explicitly via `pnpm test:shorts-external` with CU_TEST_PYTHON,
// CU_TEST_RECEIVER_SCRIPT and SHORTS_OPERATIONS_ROOT set; the suite fails loudly when the
// external configuration is absent instead of skipping.
export default defineConfig({
  test: {
    environment: "node",
    // Forks pool: file-per-process isolation for env-mutating fixtures, mirroring server config.
    pool: "forks",
    include: ["tests/external/*.external.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
