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

This is a starting map, not complete LF0 acceptance: all large-file exports,
dynamic and external consumers, tests, debug logging and change-frequency risk
still need classification. In particular, no extraction or change of execution,
recovery, ownership, lock or callback behavior is authorized by this inventory.
