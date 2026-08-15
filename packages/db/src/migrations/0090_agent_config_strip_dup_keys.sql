-- P3 cleanup: remove the duplicated agent-level keys from adapter_config.
-- P1 backfilled these keys into agent_config (copy-only); P2 moved all writers
-- and readers to agentConfig (merged read, agentConfig priority). This one-shot
-- strip is behavior-neutral for every merged reader.
--
-- Defensive form: a key is stripped from adapter_config ONLY when the same key
-- exists in agent_config, so no value can be lost even if a row drifted.
UPDATE "agents"
SET "adapter_config" = "adapter_config" - ARRAY(
  SELECT k
  FROM jsonb_object_keys("adapter_config") AS k
  WHERE k IN (
    'cwd',
    'instructionsFilePath',
    'instructionsBundleMode',
    'instructionsRootPath',
    'instructionsEntryFile',
    'promptTemplate',
    'bootstrapPromptTemplate',
    'paperclipSkillSync',
    'agentsMdPath'
  )
    AND "agent_config" ? k
)::text[];
