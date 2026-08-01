-- Blocker 3: ensure a single finalization parent per heartbeat run.
-- Concurrent terminal hooks (setRunStatus + finalizeLinkedRunsForIssueStatus)
-- could both insert a parent for the same run. This unique constraint prevents
-- duplicates; ensureFinalization uses ON CONFLICT DO NOTHING to handle the race.
ALTER TABLE heartbeat_run_finalizations
  ADD CONSTRAINT heartbeat_run_finalizations_heartbeat_run_id_uniq UNIQUE (heartbeat_run_id);
