# Judgment configurable endpoint/model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the judgment (Jev) layer's endpoint and model overridable from instance general settings (UI → saved config → actual provider request), with existing Jev defaults preserved when unset.

**Architecture:** Add two optional fields (`judgmentBaseUrl`, `judgmentModelId`) to the existing instance general settings singleton (JSONB, no migration). The judgment service resolves them at call time and passes `baseUrl` into `createTypesafeProvider` and uses the override model instead of the definition's `modelId`. No new provider framework; TypeSafe SDK protocol (`POST /v1/systemone`) unchanged.

**Tech Stack:** TypeScript, zod (shared validators), Drizzle JSONB singleton, React + react-query (UI), vitest (embedded PG + injected fetch), pnpm workspace.

**Spec:** User request 2026-09-23 (notebook `judgment-configurable-provider`): "judgement 에서 model 은 jev fix 가 아니라 endpoint 와 model 은 변경 가능한 걸로. 다른 adapter 에서 model change 하듯이." Scope answer A selected: TypeSafe-compatible endpoint override only; OpenAI-protocol translation is explicitly out of scope (unapproved separate work).

## Global Constraints

- Execution source of truth untouched: gate (`PAPERCLIP_JUDGMENT_ENABLED`), egress secret checks, response schema validation, retries, total timeout, audit-row-per-call — behavior unchanged (runtime AGENTS.md rule 7).
- No plaintext secrets in general settings: the SDK bearer key remains `TYPESAFE_API_KEY` from server env. UI must disclose that this key is sent to the configured address.
- Base URL contract: `http(s)://` only, no userinfo, no query, no fragment, ≤2048 chars. Model id: 1–200 chars, `[A-Za-z0-9._:/-]`. `null` clears an override; `undefined`/absent leaves it.
- Unset override ⇒ byte-equivalent existing behavior: default endpoint `https://api.typesafe.ai` (provider.ts `TYPESAFE_API_BASE_URL`) and per-definition `modelId` (e.g. `jev-1.13.0`).
- Files >300 lines must not grow (runtime AGENTS.md rule 8): extract judgment pricing out of `judgment-service.ts` to keep its net size flat-or-smaller.
- Full verification before hand-off: `pnpm -r typecheck`, `pnpm test:run`, `pnpm build` in the worktree.
- No deployment, no live provider swap, no company-specific settings, no `providerId` selector, no Laya work.
- Worktree: `/Users/kwak/orca/workspaces/papercompany-runtime/judgment-configurable-provider`, branch `insightflo/judgment-configurable-provider`, based on `origin/main` (1c03e7e).

## Global-progress record (user rule)

- 최종 목표/승인 범위: 위 Goal과 같음. UI→저장→실제 요청까지 연결이 이번 단계의 완료 조건.
- 현재 단계: 최소 연결(전체 경로 1회 통과) + 격리 검증. 세부 강화(회사별 설정, 자격증명 UI, 프로토콜 변환)는 이번에 하지 않음.
- 이번 해소 조건: (1) 설정 저장/조회에 새 필드가 살아있고 (2) 저장값이 실제 SDK 요청 URL·모델에 반영되며 (3) 미설정 시 기존 동작 유지가 테스트로 증명됨.
- 완료 증거: 아래 Task별 RED→GREEN 로그, 전체 typecheck/test/build, 커밋 해시.
- 한계 고지(구현 후 보고서에 포함): 커스텀 주소에도 기존 `TYPESAFE_API_KEY`가 전송됨; 비용 추정은 여전히 typesafe 정의 단가 기준; endpoint 도달성 검증 없음.

---

### Task 1: Shared contract — general settings fields

**Files:**
- Modify: `packages/shared/src/validators/instance.ts`
- Modify: `packages/shared/src/types/instance.ts`
- Test: `packages/shared/src/validators/instance.test.ts` (create)

**Interfaces:**
- Produces: `judgmentBaseUrlSchema`, `judgmentModelIdSchema` (zod, nullable string), extended `instanceGeneralSettingsSchema` / `patchInstanceGeneralSettingsSchema`, `InstanceGeneralSettings { judgmentBaseUrl?: string; judgmentModelId?: string }`.

- [ ] **Step 1: RED — write failing tests**

```ts
// packages/shared/src/validators/instance.test.ts
import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  judgmentBaseUrlSchema,
  judgmentModelIdSchema,
} from "./instance";

describe("judgment override settings", () => {
  it("accepts https endpoint without userinfo/query/fragment", () => {
    expect(judgmentBaseUrlSchema.parse("https://api.example.com")).toBe("https://api.example.com");
    expect(judgmentBaseUrlSchema.parse("http://127.0.0.1:19871")).toBe("http://127.0.0.1:19871");
    expect(judgmentBaseUrlSchema.parse(null)).toBeNull();
  });
  it("rejects bad endpoints", () => {
    expect(() => judgmentBaseUrlSchema.parse("ftp://x")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://u:p@api.example.com")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://api.example.com/v1?key=1")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://api.example.com/#frag")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("")).toThrow();
  });
  it("accepts explicit null and rejects bad model ids", () => {
    expect(judgmentModelIdSchema.parse(null)).toBeNull();
    expect(judgmentModelIdSchema.parse("jev-1.13.0")).toBe("jev-1.13.0");
    expect(() => judgmentModelIdSchema.parse("bad model id!")).toThrow();
  });
  it("general settings schema keeps unknown keys out and allows optional overrides", () => {
    const parsed = instanceGeneralSettingsSchema.parse({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" });
    expect(parsed.censorUsernameInLogs).toBe(false);
    expect(parsed.judgmentBaseUrl).toBe("https://api.example.com");
    expect(instanceGeneralSettingsSchema.parse({}).judgmentBaseUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect failure** `pnpm --filter @paperclipai/shared test -- instance.test.ts` (or repo-standard vitest invocation) → FAIL (exports missing).
- [ ] **Step 3: GREEN — implement** field schemas + compose into `instanceGeneralSettingsSchema` (`judgmentBaseUrl: judgmentBaseUrlSchema.optional()`, same for model), mirror optional fields in `InstanceGeneralSettings` interface. Keep `.strict()`; do not touch experimental schema.
- [ ] **Step 4: Run — pass.** **Step 5: Commit** `feat(shared): judgment endpoint/model override fields in instance general settings`.

### Task 2: Server normalization — persist without dropping other keys

**Files:**
- Modify: `server/src/services/instance-settings.ts` (`normalizeGeneralSettings` only)
- Test: `server/src/__tests__/instance-settings-routes.test.ts` (extend) or focused unit test via service with test DB fixture

**Interfaces:** Consumes Task 1 schemas. Produces: `getGeneral()` returns overrides when saved; invalid stored values drop only that field.

- [ ] **Step 1: RED** — test: PATCH general with `{ judgmentBaseUrl: "https://api.example.com" }` → GET returns it; PATCH `{ judgmentModelId: null }` clears only model; stored garbage for one field does not reset `censorUsernameInLogs`.
- [ ] **Step 2: Run — expect failure.**
- [ ] **Step 3: GREEN** — normalization returns overrides only when non-null, and validates each new field individually (per-field `safeParse`) so one bad value doesn't default the whole object.
- [ ] **Step 4: pass.** **Step 5: Commit** `feat(server): persist judgment overrides in instance general settings`.

### Task 3: Provider config resolution + pricing extraction

**Files:**
- Create: `server/src/services/judgment/provider-config.ts` — `resolveJudgmentProviderConfig(db): Promise<{ baseUrl?: string; modelId?: string }>` reading `instanceSettingsService(db).getGeneral()`, plus pure `resolveJudgmentModel(config, definitionModelId)`.
- Create: `server/src/services/judgment/pricing.ts` — move `JUDGMENT_PROVIDER_PRICING` + `computeJudgmentCostUsd` verbatim from judgment-service.ts; keep a one-line re-export there for compatibility (then update `judgment-service.test.ts` import and drop the re-export if nothing else imports it).
- Modify: `server/src/services/judgment/judgment-service.ts` — in `askJudgment` step 4: when `deps.provider` is NOT injected, read config once per call; `createTypesafeProvider(config.baseUrl ? { baseUrl: config.baseUrl } : {})`; `model: resolveJudgmentModel(config, definition.modelId)`. Injected provider path unchanged (no settings read — keeps existing tests/mocks authoritative).
- Test: `server/src/__tests__/judgment-provider-config.test.ts` (create; embedded-PG or db fixture per existing helpers)

**Interfaces:** Produces `resolveJudgmentProviderConfig`, `resolveJudgmentModel(config: {modelId?: string}, definitionModelId: string): string`.

- [ ] **Step 1: RED** — with settings saved (`judgmentModelId: "alt-model-1"`), `resolveJudgmentModel` returns it; unset returns definition id; null returns definition id.
- [ ] **Step 2: expect failure.**
- [ ] **Step 3: GREEN** — implement resolver + extraction; wire service (≤6 added lines in judgment-service.ts; file must not exceed 362 lines).
- [ ] **Step 4: pass.** **Step 5: Commit** `refactor(judgment): provider config resolver and pricing extraction`.

### Task 4: Whole-path proof — saved settings reach the real request

**Files:**
- Test: `server/src/__tests__/judgment-configurable-endpoint.test.ts` (create; embedded PG + real provider with injected `fetchFn`, pattern from `judgment-provider.test.ts`)

- [ ] **Step 1: RED** — seed company + active definition (`modelId: "jev-1.13.0"`); PATCH settings `{ judgmentBaseUrl: "http://127.0.0.1:9", judgmentModelId: "alt-model-1" }`; call `askJudgment` with gate enabled; captured `fetchFn` asserts request URL origin equals `http://127.0.0.1:9` and parsed body `model === "alt-model-1"`.
- [ ] **Step 2: expect failure** (request still goes to default endpoint/model).
- [ ] **Step 3: GREEN** — only if Task 3 wiring incomplete; otherwise this test may already pass — verify it fails for the right reason first by writing it before any wiring change it depends on.
- [ ] **Step 4: Regression green** — existing `judgment-service.test.ts`, `judgment-provider.test.ts`, `judgment-plan-qa-shadow.test.ts` pass unchanged (unset ⇒ default endpoint + definition model; gate off / egress block ⇒ zero sends).
- [ ] **Step 5: Commit** `test(judgment): saved settings drive real provider request`.

### Task 5: UI — judgment connection fields

**Files:**
- Modify: `ui/src/pages/InstanceGeneralSettings.tsx` — new "Judgment connection" section: Base URL input, Model id input, Save button (draft state, one `updateGeneral` PATCH sending both fields, `null` for cleared), helper text: TypeSafe 호환 판단 API 주소(비우면 기본값), 모델 미설정 시 정의별 모델 사용, 서버 환경의 기존 판단 API 키가 이 주소로 전송됨. Export pure helpers (`toJudgmentDraft(settings)`, `toGeneralPatch(drafts)`) for tests. Page must stay ≤ ~200 lines.
- Modify: `ui/src/api/instanceSettings.ts` — no change (patch is generic) unless types require it.
- Test: `ui/src/pages/InstanceGeneralSettings.test.tsx` (create; node env `renderToStaticMarkup` + helper unit tests, pattern from `InstanceSettings.test.tsx`)

- [ ] **Step 1: RED** — helper tests: draft from empty settings yields empty strings; patch from drafts maps blank→null (clear) / value; static markup contains the two labeled inputs and the key-forwarding warning.
- [ ] **Step 2: expect failure.**
- [ ] **Step 3: GREEN** — implement section.
- [ ] **Step 4: pass.** **Step 5: Commit** `feat(ui): judgment endpoint/model fields in instance general settings`.

### Task 6: Full verification + hand-off

- [ ] `pnpm -r typecheck` → exit 0.
- [ ] `pnpm test:run` → pass; list any pre-existing failures separately with evidence (do not silently widen scope).
- [ ] `pnpm build` → exit 0.
- [ ] Push branch; open PR to `main` (no merge/deploy). Report: files changed, RED→GREEN evidence, full-suite evidence, non-obvious changes (key-forwarding to custom endpoint, cost-estimate still typesafe-rate based, no reachability check, instance-wide scope).
