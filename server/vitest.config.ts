import { defineConfig } from "vitest/config";

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
  },
});
