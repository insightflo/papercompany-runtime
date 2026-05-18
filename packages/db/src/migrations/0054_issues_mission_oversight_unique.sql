CREATE UNIQUE INDEX IF NOT EXISTS issues_mission_main_executor_oversight_uq
  ON issues (mission_id)
  WHERE origin_kind = 'mission_main_executor_oversight'
    AND mission_id IS NOT NULL;
