# Native manual-onboarding invocation provenance

## Final integration verification — 2026-09-30

The approved Oversight v3.1 code/isolated-verification work is complete; production is unapplied. Final typecheck/build exited 0. All 966 test files were collected; two initially failed shards passed one same-source/settings rerun. The combined result is 7,236 passed, 0 failed, 2 pre-existing skipped, not a single all-green run. Runtime 3,011 and tools 35 source files stayed unchanged; tools independently passed 121 tests in `--network none`. Full evidence and limitations are preserved in `/Users/kwak/Projects/ai/papercompany/papercompany-artifacts/reports/oversight-v31-implementation-20260930/README.md` and `VERIFICATION.md`. This does not change `loadedBytesAttested:false` or promote diagnostic provenance into authority.

## Contract

This is diagnostic evidence, not authorization or a completion verdict. Scope: the native builtin executor invoking a member of the approved eight-file manual-onboarding bundle. QA, publish, verify, and hub commands share this boundary. Remote adapters and nested tools launched by these scripts are not attested.

`workflow.tool-call-provenance.v1` is produced and strictly validated by the server. It is attached to `body.invocationProvenance` (not `body.data`) and appended to the existing company-scoped `activity_log` as `workflow.tool_call_provenance`, with the tool ID as entity and the request/run/step IDs inside the record. The `prepared` record precedes dispatch; `returned` or `threw` follows the executor promise. A prepared-only row does not prove spawn or external completion. A returned row does not prove QA acceptance or publishing completion. Earlier requests are not overwritten.

Evidence contains:

- The executable resolved from the **effective child PATH**, pinned as the executable for that call, and its SHA256/size. Direct executable scripts also capture the interpreter resolved from a simple shebang, including `/usr/bin/env node`. Unsupported shebangs are explicitly unavailable.
- Eight individual installed file hashes plus an ordered relative-name/hash/size bundle hash. Missing files are explicit, with a null aggregate hash; this diagnostic does not introduce a new dispatch gate or silently change the approved deployment baseline.
- Core process PID, host, Node version, estimated process-start time from uptime, process executable and entrypoint, and module-initialization disk hashes for the fixed four-file executor boundary. This is not a recursive dependency scanner or Git HEAD attribution.

## Important limits

Both records explicitly set `loadedBytesAttested:false`. Disk snapshots are not proof of all bytes loaded by V8 or the kernel; mutable files can change between observation and load. The fixed core snapshot is observed at module initialization, not an immutable process-start release manifest. It does not cover every dependency, loader, native library, or nested subprocess. Node's `NODE_OPTIONS` and arbitrary wrapper semantics are not fully attested. Existing QA pre/post bundle checks remain separate. No provenance field drives retry, approval, QA verdict, or execution branching. Audit insertion failure warns and does not turn a completed external-effect tool into a retry.

## Focused verification

```sh
env -u DATABASE_URL pnpm exec vitest run \
  server/src/__tests__/workflow-tool-call-provenance.test.ts \
  server/src/__tests__/workflow-qa-byte-transport.test.ts --maxWorkers=1 --minWorkers=1
env -u DATABASE_URL pnpm --filter @paperclipai/server exec tsc --noEmit
```

The provenance tests use real local child processes and an isolated embedded database. They do not call a live CMS. Actual external-capable producer tests must run in the existing Docker context with `--network none`, not merely fake credentials.
