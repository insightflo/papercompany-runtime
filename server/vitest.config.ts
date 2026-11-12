import { configDefaults, defineConfig } from "vitest/config";

// [ci-serial-split] 중량 통합 스위트 3종(동시 4-fork embedded-PG + Python 락 경합)은 전용
//   직렬 잡 verify-tests-serial 이 --no-file-parallelism 으로 독점 실행한다. 병렬 샤드
//   (verify-tests 1~3)에서는 PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES=1 일 때만 이 파일들을
//   추가 제외해 중복 실행·경합을 원천 차단한다. configDefaults.exclude 와 합집합으로
//   배제해 기본 제외 목록(node_modules, dist 등)을 100% 보존하며, 미설정 시 기존대로 포함한다.
const serialOnlySuites = process.env.PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES === "1"
  ? [
      "src/__tests__/heartbeat-c5-public-activation.test.ts",
      "src/__tests__/qa-remediation-admission-root.test.ts",
      "src/__tests__/mission-owner-authority-flow.integration.test.ts",
    ]
  : [];

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    // [목적] 파일별 child process 분리 → process.env / globalThis 변이가 다른
    //   테스트 파일로 누출되지 않게 한다. 여러 server 테스트가 process.env
    //   (HOME, PAPERCLIP_HOME, CODEX_HOME, ... )를 바꾸는데, 기본 threads 풀에선
    //   같은 worker의 뒤따른 파일로 새어나가 순서 의존적 flake를 일으킨다.
    //   forks 풀이 파일별 프로세스를 보장해 cross-file leak을 원천 차단한다.
    //   (env-mutating 테스트들의 afterAll restore는 threads에서도 안전하게 하는
    //   defense-in-depth로 유지.)
    pool: "forks",
    testTimeout: 10_000,
    exclude: [...configDefaults.exclude, ...serialOnlySuites],
  },
});
