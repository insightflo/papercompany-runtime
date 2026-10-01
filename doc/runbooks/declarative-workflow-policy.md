# Declarative workflow policy

Audience: board operators and planning/tool authors. Configure roles and delivery
policy before deploying the Phase B runtime; upgrading code alone does not preserve
workflows that relied on names or prose.

## Saved step settings

- `deliveryVerification: "required"`: the step requires downstream delivery
  readback. Omit the field when it is not required; other values are rejected.
- `capAcceptance: "blocked"`: the step cannot be accepted automatically at the
  rework cap. This is independent of its description and tool name.
- `qaType: "delivery"`: explicitly identifies delivery readback. Existing semantic
  and structural QA types retain their distinct execution contracts.
- `type: "qa"`: explicitly identifies a QA step when no QA type is specified.
  Supported existing action/QA/oversight type aliases remain supported.

Names, descriptions, `[QA]`/`[ACTION]` title tags and identifier prefixes do not
establish roles. Planner tags originated in agent text, not a versioned machine
contract; identifier prefixes had no documented authority contract. Both are now
identity/display only. Generated planning examples and materialized steps declare
roles explicitly. Dynamic owner planning likewise requires explicit workflow mode,
not a workflow name or plan title.

The two new policies use the existing board-only QA-policy authorization, locked
row comparison and workflow mutation activity log. Invalid values are rejected at
HTTP and direct save boundaries. Plans cannot grant these board-owned policies:
a policy field anywhere in plan units, metadata or draft steps produces the
`board_only_plan_policy` diagnostic. Configure the saved workflow through the board
API instead. This restriction also applies to plans submitted by board actors.

## Tool roles and execution snapshots

A selected tool with a valid `adapterConfig.artifactContract.role` of `publication`
makes a step delivery-relevant, even without the explicit step flag. A
`publication-verify` tool makes it a readback step. No tool-name or partial role-only
object is sufficient: the full artifact declaration must pass the shared validator.
See [artifact-contracts.md](artifact-contracts.md).

Company-scoped enabled tools are resolved when the execution definition is built.
Derived delivery requirements and the internal `deliveryRole` are captured in that
immutable definition. Later reads use the snapshot, not edited live tools.
`deliveryRole` is server-derived and cannot be supplied as a workflow policy; it
preserves readback identity without overwriting an explicit structural or semantic
`qaType`. Missing QA type on a declared verifier defaults to delivery QA.

A delivery producer without downstream readback receives a synthetic delivery gate.
At the rework cap, explicit delivery readback, structural QA and blocked cap policy
retain hard-stop behavior. Neither keyword text nor a success comment authorizes
acceptance. Existing durable verdict and attempt checks remain authoritative.

## Planning topology and context

Each publication unit requires a downstream publication-verify unit whose declared
`consumerParams.receipt` argument is exactly
`{$steps.<publication-unit-id>.workProductPath}`. Conservative autofill applies only
to an unambiguous single producer/consumer pair; conflicting input is not replaced.

Publication intent is selected-tool contract data. Audience/scenario intent uses
explicit arrays; quality signals use explicit settings. Prose no longer supplies
these execution decisions or infers artifact input kinds for placement rejection.
Tool grants, availability and declared structural capability checks remain in force.
Research/durable/structural planning templates require explicit selection instead
of keyword auto-selection. Escalation-only oversight plan entries are metadata, not
normal-path work; normal units cannot depend on those excluded entries.

Optional publication site-resource discovery uses
`PAPERCOMPANY_PUBLICATION_SITE_ROOT`. There is no default directory and no legacy
environment-name alias. If unset, discovery is disabled. Research tools are no longer
added merely because a mission contains research wording.

## Migration and rollout prerequisites

The forward template data migration disables only the historical system seed key;
it never deletes bodies, IDs, custom copies or existing plan references. The new
generic seed does not overwrite existing settings or re-enable an existing row.
Operators must reselect a valid enabled template for future submissions that refer
to the retired seed.

Operational workflow/tool data migration is a separate phase. Export and review
all former title/tag/identifier-based roles, delivery producers/readbacks and cap
blocks. Include all such steps, not only the surveyed examples. Full tool contracts
must be confirmed against actual producer formats; a proposed role patch is not a
migration-ready contract.

**Do not deploy Phase B over resumable legacy executions.** Old and new snapshots
share normalizer version 1 and cannot be reliably distinguished by missing role
fields. An old title-only QA step would otherwise become unknown and bypass QA
interpretation. In the old runtime, stop admissions/schedules, finish or explicitly
cancel every active, queued, paused or otherwise resumable legacy execution, then
review explicit definitions before starting new runs. Do not mutate immutable
snapshots. Any unfinished work requires an explicitly reviewed replacement run.
This is an operational deployment prerequisite, not an automatic compatibility gate
implemented by Phase B. Supporting seamless legacy continuation would require a
separate versioned snapshot migration design.

Local tests and builds do not establish operational data readiness. Phase B performs
no remote migration, deployment or heartbeat-finalization enablement.
