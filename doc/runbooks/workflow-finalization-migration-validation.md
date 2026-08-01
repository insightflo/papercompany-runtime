# Workflow-finalization migration validation

## Purpose and gate

This runbook validates the Phase B legacy backfill in migration `0084_workflow_finalization_phase_b_backfill.sql` after Phase A migrations `0081`–`0083` are present.

**Every query below is audit-only and read-only.** Do not repair rows from this runbook. Do not add `NOT NULL`, `CHECK`, foreign-key validation, or composite-uniqueness constraints in this phase. The separate constraint phase may proceed **only when every dirty-row report below returns zero rows**. A nonzero result is a rollout blocker and must be investigated without guessing historical authority.

Run the baseline fingerprint before 0084 and retain its output with the migration receipt. Apply 0084 through the normal migration runner, retain its `NOTICE` batch receipts, then rerun the same fingerprint and every dirty-row report. Run the reports on a production-sized restored clone before production rollout.

## 1. Before/after row counts and fingerprints

Run this query before and after 0084. Save both results. `row_fingerprint` is a deterministic, order-independent audit checksum; it is not a cryptographic proof. The heartbeat fingerprint is expected to change only because 0084 adds inert tokens, epoch `0`, and legacy scope. The other counts must not change.

```sql
SELECT
  'heartbeat_runs' AS relation,
  COUNT(*) AS row_count,
  COUNT(*) FILTER (WHERE execution_token IS NULL) AS null_execution_token_count,
  COUNT(*) FILTER (WHERE execution_epoch IS NULL) AS null_execution_epoch_count,
  COUNT(*) FILTER (WHERE execution_scope_kind IS NULL) AS null_execution_scope_count,
  COALESCE(
    bit_xor(hashtextextended(
      concat_ws('|', id::text, COALESCE(execution_token::text, '<null>'),
        COALESCE(execution_epoch::text, '<null>'), COALESCE(execution_scope_kind, '<null>')),
      0
    )),
    0::bigint
  ) AS row_fingerprint
FROM heartbeat_runs
UNION ALL
SELECT
  'workflow_delegations' AS relation,
  COUNT(*) AS row_count,
  COUNT(*) FILTER (WHERE source_execution_generation IS NULL) AS null_execution_token_count,
  NULL::bigint AS null_execution_epoch_count,
  NULL::bigint AS null_execution_scope_count,
  COALESCE(
    bit_xor(hashtextextended(
      concat_ws('|', id::text, source_workflow_run_id::text,
        source_workflow_step_run_id::text, COALESCE(source_execution_generation::text, '<null>')),
      0
    )),
    0::bigint
  ) AS row_fingerprint
FROM workflow_delegations
UNION ALL
SELECT
  'workflow_step_runs' AS relation,
  COUNT(*) AS row_count,
  NULL::bigint AS null_execution_token_count,
  COUNT(*) FILTER (WHERE execution_generation IS NULL) AS null_execution_epoch_count,
  COUNT(*) FILTER (WHERE dispatch_authority_kind IS NULL) AS null_execution_scope_count,
  COALESCE(
    bit_xor(hashtextextended(
      concat_ws('|', id::text, COALESCE(dispatch_authority_kind, '<null>'),
        COALESCE(execution_generation::text, '<null>')),
      0
    )),
    0::bigint
  ) AS row_fingerprint
FROM workflow_step_runs;
```

## 2. Heartbeat execution-token integrity

Expected result: zero rows. A duplicate or null token is dirty data. The Phase B tokens are inert legacy markers, never adapter-acknowledgement capabilities.

```sql
WITH duplicate_tokens AS (
  SELECT execution_token
  FROM heartbeat_runs
  WHERE execution_token IS NOT NULL
  GROUP BY execution_token
  HAVING COUNT(*) > 1
)
SELECT
  CASE WHEN heartbeat.execution_token IS NULL THEN 'null_execution_token'
       ELSE 'duplicate_execution_token' END AS violation,
  heartbeat.id AS heartbeat_run_id,
  heartbeat.company_id,
  heartbeat.execution_token,
  heartbeat.execution_epoch,
  heartbeat.execution_scope_kind,
  heartbeat.finalization_version
FROM heartbeat_runs AS heartbeat
LEFT JOIN duplicate_tokens AS duplicate
  ON duplicate.execution_token = heartbeat.execution_token
WHERE heartbeat.execution_token IS NULL
   OR duplicate.execution_token IS NOT NULL
ORDER BY violation, heartbeat.company_id, heartbeat.id;
```

## 3. Legacy token must not be reused as v1 authority

Expected result: zero rows. This catches a version-0 heartbeat token appearing on an acknowledged owner, a version-1 heartbeat, or a version-1 finalization parent.

```sql
WITH legacy_tokens AS (
  SELECT id, company_id, execution_token
  FROM heartbeat_runs
  WHERE finalization_version = 0
    AND execution_token IS NOT NULL
)
SELECT
  'acknowledged_owner' AS violation,
  legacy.id AS legacy_heartbeat_run_id,
  referenced.id::text AS referenced_id,
  legacy.execution_token
FROM legacy_tokens AS legacy
JOIN heartbeat_runs AS referenced
  ON referenced.execution_token = legacy.execution_token
WHERE referenced.executor_owner_acknowledged_at IS NOT NULL
UNION ALL
SELECT
  'version_one_heartbeat' AS violation,
  legacy.id AS legacy_heartbeat_run_id,
  referenced.id::text AS referenced_id,
  legacy.execution_token
FROM legacy_tokens AS legacy
JOIN heartbeat_runs AS referenced
  ON referenced.execution_token = legacy.execution_token
WHERE referenced.finalization_version > 0
UNION ALL
SELECT
  'version_one_finalization_parent' AS violation,
  legacy.id AS legacy_heartbeat_run_id,
  finalization.id::text AS referenced_id,
  legacy.execution_token
FROM legacy_tokens AS legacy
JOIN heartbeat_run_finalizations AS finalization
  ON finalization.execution_token = legacy.execution_token
WHERE finalization.finalization_version > 0
ORDER BY 1, 2, 3;
```

## 4. Delegation source generation integrity

Expected result: zero rows. Rows with a missing source step, source workflow-run mismatch, null generation, or source-generation mismatch are dirty data. Leave them unmodified; 0084 intentionally backfills only an exact legacy, generation-0 source step in the same source workflow run.

```sql
SELECT
  delegation.id AS workflow_delegation_id,
  delegation.source_company_id,
  delegation.source_workflow_run_id,
  delegation.source_workflow_step_run_id,
  delegation.source_execution_generation,
  source_step.workflow_run_id AS actual_source_workflow_run_id,
  source_step.dispatch_authority_kind AS actual_source_authority_kind,
  source_step.execution_generation AS actual_source_execution_generation,
  delegation.source_execution_generation IS NULL AS has_null_generation,
  source_step.id IS NULL AS has_missing_source_step,
  source_step.workflow_run_id IS DISTINCT FROM delegation.source_workflow_run_id AS has_source_run_mismatch,
  (
    source_step.id IS NOT NULL
    AND delegation.source_execution_generation IS NOT NULL
    AND source_step.execution_generation IS DISTINCT FROM delegation.source_execution_generation
  ) AS has_generation_mismatch
FROM workflow_delegations AS delegation
LEFT JOIN workflow_step_runs AS source_step
  ON source_step.id = delegation.source_workflow_step_run_id
WHERE delegation.source_execution_generation IS NULL
   OR source_step.id IS NULL
   OR source_step.workflow_run_id IS DISTINCT FROM delegation.source_workflow_run_id
   OR (
     delegation.source_execution_generation IS NOT NULL
     AND source_step.execution_generation IS DISTINCT FROM delegation.source_execution_generation
   )
ORDER BY delegation.source_company_id, delegation.id;
```

## 5. Duplicate delegation generation keys

Expected result: zero rows. This report is required before replacing the legacy source-step uniqueness with the later composite `(source_workflow_step_run_id, source_execution_generation)` uniqueness constraint.

```sql
SELECT
  source_workflow_step_run_id,
  source_execution_generation,
  COUNT(*) AS duplicate_count,
  array_agg(id ORDER BY id) AS workflow_delegation_ids
FROM workflow_delegations
GROUP BY source_workflow_step_run_id, source_execution_generation
HAVING COUNT(*) > 1
ORDER BY source_workflow_step_run_id, source_execution_generation;
```

## 6. Version-1 typed linkage, finalization parent, scope, and authority event

Expected result: zero rows. The `workflow_step` scope requires an exact same-company version-1 workflow run, current heartbeat-required step owner, and generation linkage. Non-workflow scopes (`issue_nonworkflow`, `mission_nonworkflow`, `timer`, `manual_on_demand`, and `automation_nonworkflow`) do not require workflow linkage. The event query requires the typed heartbeat/finalization binding, not a timestamp inference or a comment.

```sql
WITH version_one_heartbeats AS (
  SELECT
    heartbeat.*,
    source_step.workflow_run_id AS linked_workflow_run_id,
    source_step.execution_generation AS linked_step_generation,
    source_step.dispatch_authority_kind AS linked_step_authority_kind,
    source_step.dispatch_owner_heartbeat_run_id AS linked_step_owner_heartbeat_run_id,
    workflow_run.company_id AS linked_workflow_company_id,
    workflow_run.dispatch_authority_version AS linked_workflow_authority_version
  FROM heartbeat_runs AS heartbeat
  LEFT JOIN workflow_step_runs AS source_step
    ON source_step.id = heartbeat.workflow_step_run_id
  LEFT JOIN workflow_runs AS workflow_run
    ON workflow_run.id = source_step.workflow_run_id
  WHERE heartbeat.finalization_version > 0
),
version_one_steps AS (
  SELECT step_run.*, workflow_run.company_id
  FROM workflow_step_runs AS step_run
  JOIN workflow_runs AS workflow_run
    ON workflow_run.id = step_run.workflow_run_id
  WHERE workflow_run.dispatch_authority_version > 0
    AND step_run.dispatch_authority_kind <> 'legacy'
)
SELECT
  'missing_execution_scope' AS violation,
  heartbeat.id AS heartbeat_run_id,
  heartbeat.workflow_step_run_id,
  heartbeat.linked_workflow_run_id AS workflow_run_id,
  heartbeat.execution_scope_kind,
  heartbeat.finalization_version
FROM version_one_heartbeats AS heartbeat
WHERE heartbeat.execution_scope_kind IS NULL
UNION ALL
SELECT
  'invalid_workflow_step_typed_linkage' AS violation,
  heartbeat.id AS heartbeat_run_id,
  heartbeat.workflow_step_run_id,
  heartbeat.linked_workflow_run_id AS workflow_run_id,
  heartbeat.execution_scope_kind,
  heartbeat.finalization_version
FROM version_one_heartbeats AS heartbeat
WHERE heartbeat.execution_scope_kind = 'workflow_step'
  AND (
    heartbeat.workflow_step_run_id IS NULL
    OR heartbeat.workflow_execution_generation IS NULL
    OR heartbeat.linked_workflow_run_id IS NULL
    OR heartbeat.linked_workflow_company_id IS DISTINCT FROM heartbeat.company_id
    OR heartbeat.linked_workflow_authority_version IS NULL
    OR heartbeat.linked_workflow_authority_version < 1
    OR heartbeat.linked_step_generation IS DISTINCT FROM heartbeat.workflow_execution_generation
    OR heartbeat.linked_step_authority_kind IS DISTINCT FROM 'heartbeat_required'
    OR heartbeat.linked_step_owner_heartbeat_run_id IS DISTINCT FROM heartbeat.id
  )
UNION ALL
SELECT
  'missing_finalization_parent' AS violation,
  heartbeat.id AS heartbeat_run_id,
  heartbeat.workflow_step_run_id,
  heartbeat.linked_workflow_run_id AS workflow_run_id,
  heartbeat.execution_scope_kind,
  heartbeat.finalization_version
FROM version_one_heartbeats AS heartbeat
WHERE NOT EXISTS (
  SELECT 1
  FROM heartbeat_run_finalizations AS finalization
  WHERE finalization.heartbeat_run_id = heartbeat.id
    AND finalization.execution_epoch = heartbeat.execution_epoch
    AND finalization.execution_token = heartbeat.execution_token
    AND finalization.finalization_version = heartbeat.finalization_version
)
UNION ALL
SELECT
  'missing_typed_authority_event' AS violation,
  heartbeat.id AS heartbeat_run_id,
  heartbeat.workflow_step_run_id,
  heartbeat.linked_workflow_run_id AS workflow_run_id,
  heartbeat.execution_scope_kind,
  heartbeat.finalization_version
FROM version_one_heartbeats AS heartbeat
WHERE NOT EXISTS (
  SELECT 1
  FROM workflow_transition_events AS event
  WHERE event.company_id = heartbeat.company_id
    AND event.heartbeat_run_id = heartbeat.id
    AND event.finalization_version = heartbeat.finalization_version
    AND event.execution_generation IS NOT DISTINCT FROM heartbeat.workflow_execution_generation
)
UNION ALL
SELECT
  'workflow_step_missing_authority_event' AS violation,
  NULL::uuid AS heartbeat_run_id,
  step_run.id AS workflow_step_run_id,
  step_run.workflow_run_id,
  step_run.dispatch_authority_kind AS execution_scope_kind,
  NULL::integer AS finalization_version
FROM version_one_steps AS step_run
WHERE NOT EXISTS (
  SELECT 1
  FROM workflow_transition_events AS event
  WHERE event.company_id = step_run.company_id
    AND event.workflow_run_id = step_run.workflow_run_id
    AND event.workflow_step_run_id = step_run.id
    AND event.execution_generation = step_run.execution_generation
    AND event.event_type = 'workflow_step_authority_transition'
)
ORDER BY 1, 2, 3;
```

## Completion criteria

1. Archive baseline and post-0084 fingerprints plus the per-batch `NOTICE` receipts.
2. Confirm the Phase B migration changed only null legacy-safe fields; it must not create acknowledgements, finalization parents, quiescence evidence, settlement, owner leases, readiness, or evidence timestamps.
3. Confirm sections 2–6 return zero rows on the restored production clone and again immediately after production migration.
4. Record the production `EXPLAIN (ANALYZE, BUFFERS)` and lock-duration observation for the bounded migration statements on a production-sized clone.
5. Only then schedule the separately numbered constraint phase. Zero dirty rows is mandatory; this audit never authorizes a runtime writer, reader, or dispatch change.
