Overall, the design is directionally sound for a single-node, trusted-plugin deployment, but it is not yet safe to ship as a workflow engine without tightening the execution model. The biggest gaps are idempotency, durable event handling, and host-side enforcement.

1. **`ctx.state` + concurrent `issue.updated` handlers is race-prone** - **Critical**. `ctx.state.set()` is a last-write-wins upsert with no compare-and-swap or transaction boundary ([plugin-state-store.ts#L121](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-state-store.ts#L121)), and the event bus dispatches handlers concurrently with `Promise.all` ([plugin-event-bus.ts#L166](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts#L166)). If two events touch the same workflow/run key, you can double-advance a step, lose a completion flag, or clobber a join condition. Use a DB-backed `workflow_runs` / `workflow_step_runs` model with unique constraints and idempotent transitions keyed by `eventId` or a monotonic issue version.

2. **`issue.updated` should be treated as at-least-once, never exactly-once** - **Critical**. The spec explicitly says core and plugin events are at-least-once ([PLUGIN_SPEC.md#L820](file:///Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/PLUGIN_SPEC.md#L820)), but the current bus is in-process routing only ([plugin-event-bus.ts#L13](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts#L13)), so without a durable outbox/inbox or replay mechanism, events can still be lost across restarts. The workflow engine should be written as a reconciler: on each event, re-evaluate persisted state, record the last processed event/version, and make every step transition idempotent.

3. **DAG cycle detection is missing** - **Important**. `dependsOn` is a raw array, so self-dependency or cycles will deadlock a workflow forever. The doc needs explicit validation on create/update, not just runtime join checks. Topological validation is cheap (`O(V+E)`) and should reject cycles before the workflow is activated.

4. **CLI Registry via prompt injection is not enforceable** - **Critical**. Injecting a markdown table into instructions is advisory only; an agent can ignore it. The SDK docs also say plugin workers/UI are trusted code and the frontend is not a sandbox ([packages/plugins/sdk/README.md#L42](file:///Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md#L42)). So this is not a security boundary. Tool use has to be enforced host-side with an allow-list of tool IDs, schema-validated argv, no shell-string interpolation, and approval gates for dangerous commands. Prompt text can describe the tool set, but it cannot be the control plane.

5. **Knowledge Base full static injection will blow the context budget and widen the prompt-injection surface** - **Important**. The “static → instructions” plan will not scale once KBs get large or multiple KBs are attached to one step. It also treats document content as trusted instructions, which is unsafe if any KB source is user-authored or externally synced. Use bounded retrieval: summaries + top-k chunks + hard token caps, and treat KB text as quoted reference data rather than instructions.

6. **Workflow state in `ctx.state` is durable, but using it as the only source of truth is the wrong abstraction** - **Important**. This part is recoverable across restarts because `plugin_state` is DB-backed ([plugin_state.ts#L14](file:///Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/plugin_state.ts#L14)) and plugin-owned data is retained through uninstall grace periods ([PLUGIN_SPEC.md#L1316](file:///Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/PLUGIN_SPEC.md#L1316)). But that does not mean it is a good place for workflow definitions or execution ledgers. `ctx.state` is opaque JSON, hard to query, and poor for auditing/versioning. Use tables for workflow definitions and step/run history; reserve `ctx.state` for cursors, checkpoints, or small ephemeral markers. This is especially important if reinstall could change plugin identity, because the state is keyed by `pluginId`.

7. **There is no per-agent concurrency limit** - **Important**. The existing scheduler already has a global max-concurrency cap for jobs ([plugin-job-scheduler.ts#L55](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-job-scheduler.ts#L55)), but the workflow design does not define any per-agent queue or lease. That means one agent can receive multiple ready steps at once, especially after a join, and then race its own tool usage, state writes, and cost. Add an explicit per-agent concurrency policy, preferably a lease or queue keyed by `agentId`, with a configurable `maxConcurrentSteps`.

8. **Workflow-level cost aggregation is not available in the current schema** - **Important**. `cost_events` has `agentId`, `issueId`, `projectId`, `goalId`, and `heartbeatRunId`, but no workflow identifier ([cost_events.ts#L13](file:///Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/cost_events.ts#L13)). Existing rollups are by agent, provider, biller, project, and heartbeat-run-based joins ([costs.ts#L133](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/costs.ts#L133), [costs.ts#L314](file:///Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/costs.ts#L314)). So workflow-unit spend is not reliably derivable today. Add `workflowRunId` and `workflowStepId` to the cost ledger, or you will only get indirect approximations.

9. **The rollback story is underspecified** - **Important**. `retry | skip | abort_workflow` are control-flow policies, not rollback semantics. Once a step has side effects, there is no generic undo. The design should distinguish between “stop scheduling downstream work” and “compensate prior side effects.” If you want real cleanup, define optional compensating actions per step and execute them in reverse topological order; otherwise, preserve the completed steps and mark the workflow aborted so auditability stays intact.

What I would change before implementation:
- Move workflow definitions and run history out of `ctx.state` and into durable tables.
- Add idempotency keys and a workflow execution ledger.
- Treat events as at-least-once and design for replay/reconciliation.
- Enforce CLI/tool permissions at the host boundary, not in prompts.
- Put a hard token budget on KB injection and default to retrieval.
- Add per-agent concurrency caps.
- Model rollback as compensation, not deletion.

Sources used:
- [plugin-event-bus.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts#L13)
- [plugin-state-store.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-state-store.ts#L121)
- [plugin_state.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/plugin_state.ts#L14)
- [PLUGIN_SPEC.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/PLUGIN_SPEC.md#L820)
- [PLUGIN_SPEC.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/PLUGIN_SPEC.md#L1316)
- [plugin-job-scheduler.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-job-scheduler.ts#L55)
- [cost_events.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/cost_events.ts#L13)
- [costs.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/costs.ts#L314)
- [packages/plugins/sdk/README.md](/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md#L42)

