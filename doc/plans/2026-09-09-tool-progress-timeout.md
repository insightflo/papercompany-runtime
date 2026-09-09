# Tool real-progress timeout implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Implement only the resolved contracts below, test-first. Parent owns analysis and acceptance.

**Goal:** Honor configured HTTP deadlines above five minutes and add opt-in DB-backed real-progress idle deadlines to builtin scripts and HTTP workflow tools.

**Architecture:** A tool invocation owns one durable heartbeat row, one immutable policy snapshot and a random attempt identity. Local fd3 machine messages and authenticated HTTP callbacks reach the same atomic DB progress writer; a common monitor reads that record and aborts on idle/total expiry. Progress never completes a workflow step; existing final result validation remains authoritative.

**Tech Stack:** TypeScript, Zod, Express, Drizzle/PostgreSQL, Node child_process/fetch, Vitest with embedded PostgreSQL.

## Global constraints
- Authorized implementation + local verification only. No deployment, live DB writes, registered-tool changes, new retries or scheduler changes.
- Parent analyses/reviews/verifies. Delegate implementation to `zai/glm-5.3 --thinking max` (available verified via `pi --list-models glm-5.3`); no worker-spawned agents, process management, cleanup or self-issued separate QA.
- Worktree `/Users/kwak/orca/workspaces/papercompany-runtime/tool-progress-timeout`, branch `insightflo/tool-progress-timeout`, baseline a5e8b8f.
- Source/test/support files <=300 lines. Legacy >300 files must shrink, not grow. Extract only cohesive affected helpers, preserve existing exports.
- New timeout semantics only when adapterConfig.progress is explicitly present. Opaque HTTP/builtin tools retain fixed mode. MCP and plugin dispatcher remain unchanged.
- No prose/stdout/stderr heuristics, regex JSON extraction, periodic fake heartbeats, percentage equality resets, or progress-as-success. No DB credentials provided to producers.
- No performance/production claims from mocked tests. Require real DB readback, real child process and real local HTTP callback tests.

## Source and impact proof
- HTTP `server/src/services/workflow/http-tool-adapter.ts` clamps timeoutMs to300000 and clears its abort timer after headers, before consuming JSON/diagnostic body. Preserve POST/HTTPS/auth/response assertions/atomic artifact semantics, fix both deadlines and body coverage.
- Core builtin `core-tool-executor.ts` uses promisified execFile with10MiB stdout/stderr, parameter flags, grant/approval checks. Preserve fixed behavior, use a separate fd3 transport for progress-enabled subprocesses.
- `remote-tool-executor.ts` invokes HTTP/MCP then mirrors artifact; do not mark mirrored workflow successful from progress records.
- Direct HTTP callers: `services/tools/test-executor.ts` must support the policy; `workflow/control-flow/condition-tool-source.ts` must explicitly disable progress and preserve its30s synchronous fixed limit.
- `app.ts` and `routes/plugins.ts` call core and handle final workflow completion separately: do not alter their queue/result semantics or expand these large files.
- `routes/tool-definitions.ts` is199 lines and mounted after actor middleware/boardMutationGuard. Mount callback router inside it; callback uses a dedicated header capability, NEVER board/agent authority alone. No global auth exemption.
- `workflow_step_runs` unique(run,step), retryCount,iterationIndex,executionGeneration bind progress scope; new attempt UUID additionally prevents requestId reuse from reviving older calls.
- A1 read-only producer sample: `/srv/papercompany/services/shorts-assemble/current` resolves to release20260904-b. assemble_service.py:112 blocks on subprocess.run; runner.py:275-277 likewise wraps subprocess.run. No real-progress protocol established in this sample. Do not auto-enable it or claim existing services now report progress.

## Contract decisions (locked)

### Policy and message
New `packages/shared/src/validators/tool-progress.ts` exports strict schemas and inferred types:
```ts
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const toolProgressPolicySchema = z.object({
  version: z.literal(1),
  idleTimeoutMs: z.number().int().min(1000).max(2147483647),
  maxDurationMs: z.number().int().min(1000).max(2147483647),
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    unit: z.enum(['bytes', 'items', 'frames', 'milliseconds']),
  }).strict()).min(1).max(32),
}).strict();
export const toolProgressEventSchema = z.object({
  version: z.literal(1), executionId: z.string().uuid(),
  sequence: safeCount.refine(n => n > 0),
  stage: z.string().min(1).max(64), unit: z.enum(['bytes','items','frames','milliseconds']),
  current: safeCount, total: safeCount.optional(),
}).strict();
```
Add refinements: idle<=max; stage keys unique; total when present >0 and current<=total. No producer timestamp or completion field. Policy frozen in row, not read back from mutable tool config during execution.
- Accepted sequence must increase AND actual current must increase in the same stage. Sequence alone is not progress.
- First stage must index0 with current>0. Next stage must exactly index+1 with current>0. Regressing/skipping/unknown stages or unit mismatch rejected without extending.
- total may be introduced once per stage and then cannot change/disappear; when absent no percentage is fabricated. New stage resets its counter/total. Final total reached is NOT execution success.
- Replayed/non-progress messages return `{accepted:false, reason:'no_progress'}` without writes. Malformed=>400; invalid scope/token=>401 or404; terminal/expired=>409. No token/remote-body echoes.
- Bound HTTP messages to4KiB and local fd3 records4KiB. Oversized/malformed local channel fails the progress-enabled invocation with a bounded protocol error; stdout/stderr untouched.
- Server write coalescing: minimum1000ms between persisted advances (first accepted immediately). Return `{accepted:false,reason:'throttled'}` before consuming sequence; do not queue delayed fake heartbeats. Producer reports latest counts on subsequent actual work. idleTimeoutMs should be comfortably larger than cadence (docs recommend>=10000). Tests may advance database timestamps rather than weakening production schema.

### Storage and authority
Create `packages/db/src/schema/tool_execution_heartbeats.ts`, export, generate incremental migration0102 (verify actual next number at generation).
Fields: id UUID, companyId FK, toolId FK, requestId text, adapterType text, policy jsonb typed, tokenHash nullable text, workflowRunId/stepRunId nullable UUID, stepId nullable text, executionGeneration/retryCount/iterationIndex nullable integer snapshots, startedAt/lastProgressAt timestamptz, sequence bigint(number), stageIndex integer(-1 initially), current bigint(number), total nullable bigint(number), state text(active|succeeded|failed|timed_out), finishedAt nullable timestamp, reason nullable bounded machine code. Company/execution unique identity; indexes company+startedAt and active expiry access. No plaintext token or final response blobs.
- start after authorization/config checks, immediately before execution. If provided workflow refs, require both, lookup exact same-company run and unique step; reject unresolved scope. Store DB snapshot, not env/prose values. Board tool tests have null workflow scope.
- Every accept/check/finish verifies bound step generation/retry/iteration still matches when scoped. Cancelled/terminal parent workflow rejects further advances. Never infer execution happened from workflow status.
- DB transactions lock heartbeat row and use DB `clock_timestamp()` for reception/expiry. Expiry is `now >= min(lastProgressAt+idle,startedAt+max)`; late callbacks cannot revive active-looking expired rows even if monitor has not run.
- finish success only after validated adapter response and an atomic pre-deadline state check. A timed-out row cannot become success; replay finish cannot overwrite first terminal decision. On scope replacement fail with machine reason, never dispatch anything.
- Insert activity_log for lifecycle and accepted persisted progress in the same transaction; actor system/tool-progress, entity tool_execution_heartbeat, bounded IDs/counters only. No per-log audit or secret.
- Monitor polls <=1000ms (non-overlapping reads) plus immutable total timer; rejects/aborts on DB failure rather than running indefinitely. Progress DB failure is not success. Timer cleanup on all exit paths. Row remains useful diagnostic evidence if DB is unavailable; do not claim successful terminal persistence.
- Tokens:32 random bytes, only SHA256 hash in row, exact execution/company binding; lifetime ends at deadline/finish. Callback validates hash using constant-time comparison, including local-trusted mode. Board/agent keys are not substitutes.

### Service interfaces / files
Create cohesive `server/src/services/tools/progress-{store,policy,monitor,scope}.ts` as needed (each<=300):
```ts
type ProgressScope = { companyId:string; toolId:string; requestId:string;
  adapterType:'builtin'|'http'; workflowRunId?:string|null; stepId?:string|null };
// Store is instantiated with Db; all operations bind company and execution.
start(scope:ProgressScope, policy:ToolProgressPolicy, tokenHash?:string):Promise<Heartbeat>;
accept(companyId:string, executionId:string, event:ToolProgressEvent, token?:string):Promise<ProgressReceipt>;
check(companyId:string, executionId:string):Promise<Heartbeat>;
finish(companyId:string, executionId:string, outcome:'succeeded'|'failed', reason?:string):Promise<Heartbeat>;
```
Local internal accept must be a separate internal entry, not optional-token bypass reachable through HTTP. Share atomic counter logic. Reader DTO excludes tokenHash. HTTP callback response only receipt, not full row.
Common monitor wraps a supplied execution operation with AbortSignal; final transport result still validated before finish. Race deadline against operation even for a fetch/test implementation ignoring AbortSignal; attach catches and prevent post-timeout artifact-success continuation. It cannot prove remote work stopped. Document this.

### Transport wiring
HTTP: `HttpWorkflowToolExecutionDeps` gains optional progress context `{db,toolId,workflowRunId?,stepId?,callbackBaseUrl?}`. Remote wrapper passes it (add toolId to remote input from existing core lookup); test-executor passes db/tool.id. Missing context for enabled policy=>422 before outbound call. Condition source overwrites `progress:undefined` along with30s timeout, no row.
- Callback base from explicitly injected trusted base (tests) or `PAPERCLIP_PUBLIC_URL`; require absolute HTTPS, no credentials/query/hash, permit loopback http only in explicit test injection. Missing base=>422 before dispatch. Do not derive from incoming Host or tool arguments.
- Callback `POST /api/companies/:companyId/tool-executions/:executionId/progress`, dedicated `X-Papercompany-Progress-Token` header. Router mounted inside toolDefinitionRoutes; no board access requirement for this capability-only endpoint, no mutation of ordinary actor auth.
- Outbound headers: `X-Papercompany-Progress-Version:1`, `X-Papercompany-Execution-Id`, `X-Papercompany-Progress-Url`, `X-Papercompany-Progress-Token`. Preserve existing request-id/header auth/body. Reject redirects in progress mode so capability cannot be forwarded; fixed mode redirect behavior unchanged. Redact callback token from adapter diagnostics in addition to auth secret. Never use arbitrary HTTP chunks as work progress.
- Fixed HTTP deadline: default120000, min1000 retained; remove300000 clamp. Support finite positive configured durations through2147483647 (JS timer bound); invalid/overflow values produce422 instead of immediate/overflow timer. Timer covers fetch+JSON/error body, not just headers. Return stable bounded timeout reason on body stall.
- Extract HTTP response helpers (config/assertions/persistence as cohesive units) so original adapter shrinks under300; preserve exported redactSecret/persistArtifact compatibility for MCP/tests.
Local: retain execFile fixed mode. Extract current CLI/env helpers from core as needed to shrink. Progress mode uses spawn with `stdio:['ignore','pipe','pipe','pipe']`, same argv/cwd/env and10MiB buffers, fd3 newline JSON only. Set `PAPERCOMPANY_TOOL_EXECUTION_ID` and `PAPERCOMPANY_TOOL_PROGRESS_FD=3` after user env/stepEnv. Serial bounded intake (no unbounded Promise queue), UTF8 chunk-safe framing. Abort targets only owned child; SIGTERM then SIGKILL after2s, await close before cleanup; avoid broad process matching. Preserve stdout final JSON/text and stderr behavior. Child-produced progress alone never makes exit nonzero successful.

## Delivery tasks and test-first sequence

### Task1 — thin connected implementation (single worker, complete all paths before hardening)
**Files:** shared validator and barrels; DB schema/export/migration; services/tools/progress-*; routes/tool-progress.ts and tool-definitions.ts; workflow/core-tool-executor.ts plus local-tool-progress-executor.ts / extracted core-tool-context.ts; workflow/http-tool-adapter.ts plus http-tool-response.ts; remote-tool-executor.ts; control-flow/condition-tool-source.ts; tools/test-executor.ts.
- [x] Add focused test modules `server/src/__tests__/tool-progress-{policy,store,http,local}.test.ts` plus fixtures as needed. Follow existing embedded-postgres helper, never skip silently.
- [x] RED: fixed HTTP900000 request must remain pending at300001 and time out by900000; body stalls timeout after headers. Existing behavior must fail these assertions.
- [ ] RED: actual DB store accepts current1 then current2 at eligible times, rejects larger sequence/same current; independent connection reads unchanged lastProgressAt for duplicate. Sketch assertion:
```ts
const before = await reader.select().from(toolExecutionHeartbeats);
expect(await store.acceptLocal(companyId,id,{...event,sequence:2,current:1}))
  .toMatchObject({accepted:false,reason:'no_progress'});
const after = await reader.select().from(toolExecutionHeartbeats);
expect(after[0].lastProgressAt).toEqual(before[0].lastProgressAt);
```
- [x] Implement schema/store/monitor and immediately wire local+HTTP/test/condition paths. No deep local-only polishing before HTTP works.
- [x] Real local child writes fd3 progress while stdout final result remains valid JSON; real HTTP service receives scoped headers and calls real callback router backed by real DB while final POST stays open. Both outlive idle with advances, fail idle after stopping advances, and fail immutable max despite advances.
- [x] Generate migration via `pnpm db:generate`; inspect incremental SQL (only intended new table/index/FKs), migration metadata and compatibility with existing migration chain.
- [x] Combined focused suite passes, save exact RED/GREEN logs outside tracked tree. Stop worker and return diff/commands; parent reviews before more changes.

**Task1 worker evidence (2026-09-09):** `/tmp/tool-progress-task1-handoff.md` lists exact changed paths, commands and caveats. RED HTTP9 failures: `/tmp/tool-progress-red-http-deadline.log`. Initial DB RED failed at real migrated-DB table-presence prerequisite (2 body tests skipped), not at duplicate-counter assertion; that exact RED checkbox remains open. Final independent-connection counter assertions passed. Connected GREEN19/19, combined regressions83/83 with0 skips: `/tmp/tool-progress-green-connected-1.log`, `/tmp/tool-progress-green-regressions.log`. Server source typecheck passed: `/tmp/tool-progress-server-typecheck-green.log`; test types/full workspace verification remain parent-owned. Generator emitted stale0048 historical drift; only its six exact new-table statements retained as0102. All pre-existing migration metadata restored unchanged; see `/tmp/tool-progress-scope-check.log` and `/tmp/tool-progress-migration-generate.log`.

### Task2 — parent review, targeted correction and acceptance
- [ ] Parent reviews source/diff and runs combined regressions freshly. If corrections needed, hand exact edits/tests to same designated model; no open-ended delegated analysis.
- [x] Tests: wrong company/id/token; missing token even local board; replay/out-of-order/negative/NaN/unsafe/fractional counts; undeclared/backwards/skipped stage, changed total/unit; terminal/expired callback, generation/retry replacement; concurrent progress/finish/timeout race; DB insert/update/read failures; no plaintext capability in DB/audit/errors.
- [x] Tests: stdout logs/same counters cannot reset; fd3 chunk split/malformed/oversize bounded; child exit failure; no unhandled rejection/timer/child leak; HTTP redirect capability not forwarded; invalid final response with healthy progress fails; opaque fixed/MCP/plugin untouched; condition stays30s/no row; board test uses DB context.
- [x] DB-facing proof asserts persisted state via separate connection, not just mocked SQL or row count. Inspect actual skipped counts. Do not compare huge Drizzle structures in Vitest assertions.
- [x] Add `doc/runbooks/tool-progress.md` and executable local/HTTP examples under `scripts/examples/tool-progress/` (<=300 each): report ONLY after actual file bytes/items processed, never a free-running timer. Include explicit opt-in policy, callback base, diagnostics query without tokenHash, total/idle semantics, rollback by removing progress config, producer migration and remote-cancel caveat. No existing registry configuration is changed.
- [x] Add short links/behavior text to SPEC.md, SPEC-implementation.md section11.6 and DATABASE.md; preserve strategic documents.
- [ ] Run `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`; preserve failure codes and logs. Check tests excluded from tsconfig separately; no package typecheck implies test typecheck claim. **Parent-owned; not run by Task2 resume worker.**
- [x] Verify `git diff --check`, file sizes, only task files, no lockfile changes. Report original scope / actual changes / additions and reasons / non-obvious behaviors; distinguish local verification from unshipped production.

**Task2 worker partial evidence (2026-09-09, user-authorized Astra HIGH):** Approved owned-child exit/pipe-close correction implemented test-first. `/tmp/tool-progress-task2-red.log`: lifecycle2 tests,1 expected failure (6572ms inherited-pipe wait). `/tmp/tool-progress-task2-green.log`: lifecycle2/2 passed (1025ms timeout while descendant alive; live SIGTERM-ignoring child stopped at3024ms). New real-DB counter/capability and actual middleware-chain tests combined with lifecycle:16 passed/1 failed/0 skipped in `/tmp/tool-progress-task2-contract-blocker.log`. Blocker: malformed wire JSON returns500 instead of400 through the global parser/error-handler chain. Worker stopped without changing middleware, per parent boundary. Broad Task2 checkboxes remain open; remaining matrix, docs/examples and parent-owned full checks are not completed. Handoff: `/tmp/tool-progress-task2-handoff.md`.

**Task2 resume evidence (2026-09-09, user-authorized Astra HIGH):** Parent resolved the malformed-body blocker and authorized only the narrow additional `middleware/error-handler.ts` production correction. Exact callback POST parser metadata now maps to400 without raw logging context; unrelated routes/methods/error types retain generic500. Actual middleware-chain + boundary GREEN20/20 includes >10MiB input and unchanged independent-reader row/audit. Remaining scoped/concurrency/write-rollback/monitor/local-protocol cases passed31/31, HTTP boundaries and callers10/10. Final single serial runner:26 files/171 tests passed,0 failed,0 skipped, including all tool-progress and existing HTTP/MCP/plugin/test/route regressions. No Vitest unhandled error report. `/tmp/tool-progress-task2-resume-green.log` records exact commands and outputs.

Runbook, three additive documentation links, executable byte-copy/item-processing examples, and example smoke suite are complete. Node smoke2/2 passed, standalone runbook copy matched bytes and emitted fd3 evidence, all three example files passed syntax checks. Examples are local fixtures, not a deployment. Migration0102 retains its original SHA256 and six statements; all43 tracked metadata files are byte-identical to HEAD. Resume-owned source/test/example files are <=300 lines. The inherited shared barrels remain860/477 lines, each already4 lines shorter than HEAD, untouched by this worker; initial overbroad cap-check failure and corrected ownership inventory are retained in `/tmp/tool-progress-task2-resume-scope.log`. No new production blocker was reproduced. Historical Task1 DB RED checkbox and parent review/full workspace/typecheck acceptance remain open. Precise coverage, exclusions and next checks: `/tmp/tool-progress-task2-resume-handoff.md`.

## Operational preparation / no broad changes
Worktree has no node_modules. Install worktree dependencies with repo-pinned Node24, `NODE_ENV` unset, pnpm install --frozen-lockfile (do not alter lockfile). If install fails, inspect exact cause and change approach, do not repeat identical failures. Do not symlink another worktree's package dist; builds must test own source. No live DB credentials required; embedded test database is isolated.
