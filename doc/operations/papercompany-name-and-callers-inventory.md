# Papercompany name and heartbeat consumer inventory

This is a local inventory, not authorization to rename repositories, move paths,
or change deployed services. It covers tracked working-tree files observed on
2026-11-04; untracked files, external consumers and actual server state have not
been verified. The full filename inventory is recorded separately in the
operations evidence `c5-candidate-backups/wbs/t10b-consumer-inventory.json`.

## Names and paths (N0, N2, N3)

| Repository | Observed local HEAD | Local origin | Tracked files matching `papercompany` |
| --- | --- | --- | ---: |
| runtime | bbaebd5f2a46 | insightflo/papercompany-runtime | 285 |
| operations | 40d059df4734 | insightflo/papercompany-operations | 766 |
| plugins | 8d03947b9cf9 | insightflo/papercompany-plugins | 26 |
| artifacts | 0e59dd9472c8 | no origin configured | 4779 |

Counts are file matches, not a classified or exhaustive consumer count. Other
working trees and existing `/srv/papercompany` paths remain in place. A local
remote name is not proof of the current server path, deployment configuration,
external clones, redirects or active consumers. Those require separate evidence
before any rename or move.

The runtime UI matches all fall into these groups:

| Location | Present meaning and treatment |
| --- | --- |
| `ui/src/api/auth.test.ts` | Test callback hostname; preserve historical test input. |
| `ui/src/components/CompanyRail.tsx`, `PapercompanyLogoIcon.tsx` | Internal component and symbol names; preserve until consumers and display policy are decided. |
| `ui/src/lib/commandcode-efforts.ts` | Comment; preserve. |
| `ui/src/lib/missionRevisionRequest.test.ts`, `quality-ui-helpers.test.ts`, `pages/MissionDetail.test.tsx` | Test inputs, historical URL, path and asset key; preserve. |
| `ui/src/lib/openclaw-invite-snippet.ts` | Generated invitation instructions include user-visible naming; require owner and compatibility review. |
| `ui/src/pages/ChannelConfig.tsx` | Example account placeholder; require display review. |
| `ui/src/pages/CompanySettings.tsx`, `CompanySkills.tsx` | Example filesystem paths; retain until path migration is separately decided. |

The `papercompany-deploy-a1-approved` dispatch type is consumed by both runtime's
`.github/workflows/deploy-github-repository-bridge-a1.yml` and operations'
`.github/workflows/deploy-a1-approved.yml`. The latter validates approval and
repository identity in `scripts/deploy-a1/verify-approval.mjs`; the plugin root
package currently names itself `papercompany-plugins`. These are contracts,
not display-only strings. The conservative current choice is to retain them;
producer discovery, compatibility and coordinated cutover remain unverified.
The `paperclip`, `paperclipai`, `@paperclipai/*`, `PAPERCLIP_*` and
`~/.paperclip` identifiers are also retained under the existing task contract.

### Deployment dispatch and path consumers

The bridge producer constructs `event_type` from its configured event type and
`client_payload` from the exact approval id, commit, repository and branch in
`papercompany-plugins/packages/github-repository-bridge/src/deploy-checks.ts`
and `dispatch-outbox.ts`. Its outbox is keyed by approval id plus exact commit;
`deploy-approvals.ts` sends only pending records. The README contains an example
configuration for `papercompany-deploy-a1-approved`, but that example is not
proof of the active installation. Runtime and operations workflows both listen
for this event. A name transition would therefore require the actual producer
configuration and both receivers to be coordinated while preserving pending,
sent and failed outbox identity and exact approval/revision verification.
Until then, retain the existing identifier and repository/package names; do not
create a second event or alter the approval checks.

| Boundary | Evidence in local source | Unverified before transition |
| --- | --- | --- |
| Runtime deployment | Operations `.github/workflows/deploy-a1-approved.yml` defaults to `/srv/papercompany/papercompany-runtime`; `scripts/deploy-a1/deploy-runtime-with-drain.sh` names the runtime repository. | Actual overrides, external consumers, compatibility period and rollback. |
| Plugin deployment | Runtime `scripts/deploy-github-repository-bridge-a1.sh` defaults to `/srv/papercompany/papercompany-plugins` and verifies a repository identity. | Actual override and all installed consumers. |
| Runtime/artifacts relation | Runtime `scripts/workflow-engine-core-migration-dry-run.ts` refers to `../../../papercompany-artifacts/doc/plans/`. | Other active worktrees and relative-path consumers. |
| Tax | Local tracked text search found 15 kernel and 5 portal files mentioning the old name; paths are listed in the inventory JSON. | Active Tax deployments and individual contract ownership. |
| Agent instructions | Local `papercompany-agent-instructions-v3/source/papercompany.md` contains project names; `build.py` generates `ready/` and explicitly does not install. | Generated/source parity, installation destinations and new-session loading. |

Local configuration defaults are not live-server observations. No rename,
installation, deployment or runtime flag change follows from this table.

## Heartbeat callers (LF0)

`server/src/services/heartbeat.ts` exports the `heartbeatService` factory and
other helpers. Direct users include app and startup (`server/src/app.ts`,
`server/src/index.ts`), issue, mission, approval, agent, quality and workflow
routes, Telegram, routines, plugin host and SRB dispatch. Workflow callers
include `workflow/dag-engine.ts`, `workflow/workflow-step-wake.ts`, and
`workflow/replacement-agent-delivery.ts`; mission owner handback and operator
decisions also start or resume work through the factory. The barrel
`server/src/services/index.ts` re-exports it. Type-only dynamic references to
`recordHeartbeatQueueTransitionEvent` exist in quality admission and recovery
guard; the provider-failure ladder and recovery queue use other exports.

The broader local inventory records import/export declarations, dynamic-import
and logging line numbers for six files in
`c5-candidate-backups/wbs/t10b-large-file-map.json`. Text matches are discovery
evidence rather than proof of all semantic consumers. The first risk priority
is the heartbeat and DAG engine boundary: both changed in the #464 integration
range and affect dispatch, recovery and completion. Mission supervision also
coordinates mission work. UI graph and agent detail affect presentation;
access routes retain security priority because they decide authorization.
Length alone is not the priority rule, and logging occurrences are recorded for
review rather than presumed unnecessary. Dynamic imports, reexports, tests and
consumers outside these source trees still need exact symbol-level inspection.

This is a starting map, not complete LF0 acceptance: all large-file exports,
dynamic and external consumers, tests, debug logging and change-frequency risk
still need classification. In particular, no extraction or change of execution,
recovery, ownership, lock or callback behavior is authorized by this inventory.
