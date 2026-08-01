# Workflow step-status provenance

Use this read-only query to attribute workflow step terminal flips by caller source and identify flips observed before their event-bound heartbeat finished. `workflow_transition_events` is audit data only; it must not be used as workflow dispatch authority.

```sql
WITH terminal_flips AS (
  SELECT
    event.id,
    event.company_id,
    event.workflow_run_id,
    event.workflow_step_run_id,
    event.issue_id,
    event.heartbeat_run_id,
    event.reason_code,
    event.from_status,
    event.to_status,
    event.created_at AS flipped_at
  FROM workflow_transition_events AS event
  WHERE event.event_type = 'workflow_step_status_transition'
    AND event.layer = 'workflow_sync'
    AND event.to_status IN ('completed', 'failed', 'skipped')
    AND event.from_status IS DISTINCT FROM event.to_status
), attributed AS (
  SELECT
    flip.*,
    heartbeat.id AS observed_heartbeat_run_id,
    heartbeat.status AS observed_heartbeat_status,
    heartbeat.finished_at AS observed_heartbeat_finished_at
  FROM terminal_flips AS flip
  LEFT JOIN heartbeat_runs AS heartbeat
    ON heartbeat.id = flip.heartbeat_run_id
   AND heartbeat.company_id = flip.company_id
)
SELECT
  COALESCE(reason_code, 'workflow_sync') AS reason_code,
  from_status,
  to_status,
  COUNT(*) AS transition_count,
  COUNT(*) FILTER (
    WHERE observed_heartbeat_run_id IS NOT NULL
      AND observed_heartbeat_finished_at IS NOT NULL
      AND flipped_at < observed_heartbeat_finished_at
  ) AS early_terminal_flip_count,
  MIN(flipped_at) AS first_flip_at,
  MAX(flipped_at) AS last_flip_at
FROM attributed
GROUP BY 1, 2, 3
ORDER BY early_terminal_flip_count DESC, transition_count DESC, reason_code;
```

Phase 0 has no heartbeat settlement column. For a culprit investigation, retain the event ID, workflow run/step IDs, issue ID, and observed heartbeat ID from the query result; later settlement-aware phases can replace `finished_at` with the canonical settlement timestamp.
