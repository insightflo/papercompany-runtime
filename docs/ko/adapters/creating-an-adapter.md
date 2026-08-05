---
title: 어댑터 만들기
summary: 커스텀 어댑터를 만드는 가이드
---

커스텀 어댑터를 만들어 papercompany를 어떤 에이전트 런타임과도 연결할 수 있습니다.

<Tip>
Claude Code를 사용 중이라면 `.agents/skills/create-agent-adapter` 스킬이 전체 어댑터 생성 과정을 대화형으로 안내할 수 있습니다. Claude에게 새 어댑터를 만들어 달라고 요청하면 각 단계를 하나씩 안내해 줍니다.
</Tip>

## 패키지 구조

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata
    server/
      index.ts          # Server exports
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      index.ts          # UI exports
      parse-stdout.ts   # Transcript parser
      build-config.ts   # Config builder
    cli/
      index.ts          # CLI exports
      format-event.ts   # Terminal formatter
```

## 1단계: 루트 메타데이터

`src/index.ts`는 세 소비자 모두가 가져옵니다. 의존성이 없도록 유지하세요.

```ts
export const type = "my_agent";        // snake_case, globally unique
export const label = "My Agent (local)";
export const models = [
  { id: "model-a", label: "Model A" },
];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;
```

## 2단계: 서버 실행

`src/server/execute.ts`는 핵심입니다. `AdapterExecutionContext`를 받아 `AdapterExecutionResult`를 반환합니다.

주요 책임:

1. 안전한 헬퍼(`asString`, `asNumber` 등)로 설정을 읽습니다.
2. `buildpapercompanyEnv(agent)`에 컨텍스트 변수를 더해 환경을 구성합니다.
3. `runtime.sessionParams`에서 세션 상태를 해석합니다.
4. `renderTemplate(template, data)`로 프롬프트를 렌더링합니다.
5. `runChildProcess()`로 프로세스를 실행하거나 `fetch()`로 호출합니다.
6. 사용량, 비용, 세션 상태, 오류에 대해 출력을 파싱합니다.
7. 알 수 없는 세션 오류를 처리합니다(새 세션으로 재시도, `clearSession: true` 설정).

## 3단계: 환경 테스트

`src/server/test.ts`는 실행 전에 어댑터 설정을 검증합니다.

구조화된 진단 결과를 반환합니다:

- `error` — 잘못되었거나 사용할 수 없는 설정
- `warn` — 차단하지 않는 문제
- `info` — 성공한 검사

## 4단계: UI 모듈

- `parse-stdout.ts` — 런 뷰어용으로 stdout 줄을 `TranscriptEntry[]`로 변환
- `build-config.ts` — 폼 값을 `adapterConfig` JSON으로 변환
- `ui/src/adapters/<name>/config-fields.tsx`의 설정 필드 React 컴포넌트

## 5단계: CLI 모듈

`format-event.ts` — `picocolors`를 사용해 `paperclipai run --watch`용으로 stdout을 보기 좋게 출력.

## 6단계: 등록

세 레지스트리 모두에 어댑터를 추가하세요:

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

## 스킬 주입

에이전트의 작업 디렉터리에 쓰지 않고 papercompany 스킬을 에이전트 런타임에서 발견할 수 있게 만드세요:

1. **최선: tmpdir + 플래그** — tmpdir을 만들고 스킬을 심볼릭 링크한 뒤 CLI 플래그로 전달, 이후 정리
2. **허용: 전역 설정 디렉터리** — 런타임의 전역 플러그인 디렉터리로 심볼릭 링크
3. **허용: 환경 변수** — 스킬 경로 환경 변수가 저장소의 `skills/` 디렉터리를 가리키게 함
4. **최후의 수단: 프롬프트 주입** — 프롬프트 템플릿에 스킬 내용을 포함

## 보안

- 에이전트 출력은 신뢰할 수 없는 것으로 취급(방어적으로 파싱하고 절대 실행하지 않기)
- 시크릿은 프롬프트가 아닌 환경 변수로 주입
- 런타임이 지원하면 네트워크 접근 제어 구성
- 타임아웃과 유예 시간을 항상 적용
