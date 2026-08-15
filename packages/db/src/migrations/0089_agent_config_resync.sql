UPDATE "agents"
SET "agent_config" = COALESCE(
  jsonb_strip_nulls(
    jsonb_build_object(
      'cwd', "adapter_config" -> 'cwd',
      'instructionsFilePath', "adapter_config" -> 'instructionsFilePath',
      'instructionsBundleMode', "adapter_config" -> 'instructionsBundleMode',
      'instructionsRootPath', "adapter_config" -> 'instructionsRootPath',
      'instructionsEntryFile', "adapter_config" -> 'instructionsEntryFile',
      'promptTemplate', "adapter_config" -> 'promptTemplate',
      'bootstrapPromptTemplate', "adapter_config" -> 'bootstrapPromptTemplate',
      'paperclipSkillSync', "adapter_config" -> 'paperclipSkillSync',
      'agentsMdPath', "adapter_config" -> 'agentsMdPath'
    )
  ),
  '{}'::jsonb
);
