# A1 deployment safety: legacy automatic restart retired

Audience: A1 operators and runtime contributors.

**Merging to `main` no longer deploys or restarts A1 through
`.github/workflows/deploy-a1.yml`.** Manual dispatch of this workflow also runs
verification only. This removes one source of deployment-triggered process loss;
it does not implement safe runtime drain or process-loss recovery.

## What changed

- The workflow retains its `verify` job: checkout on the GitHub runner,
  dependency installation, typecheck, health/UI smoke tests, and build.
- Its remote deployment job, SSH setup, script copy, and remote execution are
  removed. A green workflow means verification passed, not that A1 was updated.
- `scripts/deploy-a1.sh` remains as a compatibility entrypoint. It always prints
  a refusal to stderr and exits with status 1 before external commands or
  filesystem writes. It does not checkout, fetch, install, build, lock, or restart.
- Environment settings and command-line options cannot enable this script.
  `A1_LEGACY_DEPLOY_ENABLED=true` cannot restore the removed job in this revision.

## Operator action

Do not retry this legacy entrypoint or bypass its refusal with an older copy.
Use the existing separately approved Operations deployment process when a real
release is needed. That process and the approved GitHub Repository Bridge
workflow are unchanged; approval alone is **not** proof of safe shutdown.
Assess active work and the first-transition risk before authorizing a restart.
This document does not authorize any deployment or service mutation.

Before merging this retirement, the operator should set the existing repository
variable `A1_LEGACY_DEPLOY_ENABLED=false` and read it back, then inspect queued
and running legacy workflow runs. If an old deployment is active, determine its
stage before proceeding. Cancelling a workflow is not proof that a remote command
has stopped. Keep the variable disabled as a defense for compatible old runs.

After merging, verify that the new main workflow has only the verification job.
Compare A1's code revision and process start time with the pre-merge observations,
and check internal/public health without restarting the service. Applying this
GitHub workflow change requires no A1 checkout, install, build, or restart.
The copy already on A1 is not replaced by this change alone.

## Residual limits

- Old workflow reruns use old workflow definitions. Already running deployments,
  old copied scripts, and older revisions are not retroactively made safe.
- Direct SSH/systemd restarts, host failures, and other deployment paths remain
  possible. This change does not block or redesign them.
- There is no new atomic execution-admission gate or drain-and-settlement
  protocol. Installing such a protocol on an old runtime is a separate risk:
  the old process does not already have the proposed protection.
- Missing execution receipts mean an external result is unknown, not that the
  action never happened. This retirement adds no automatic retry or recovery.
- Process-loss frequency improvement needs subsequent operational observation;
  local tests and a green GitHub run cannot establish that outcome.

## Local verification

```sh
pnpm vitest run server/src/__tests__/deploy-a1-retired.test.ts server/src/__tests__/health.test.ts server/src/__tests__/app-ui-root.test.ts
bash -n scripts/deploy-a1.sh
git diff --check
```

The retirement tests execute the real Bash script in temporary directories.
Recording executables replace only external command boundaries; they never
contact A1. Tests cover default settings (with sandbox-only path overrides) and
former deployment settings, including attempted force inputs. Both must refuse
with an actionable diagnostic, zero external calls, and no deployment lock file.
These checks do not replace full repository verification or post-merge evidence.
