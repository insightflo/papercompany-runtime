-- P4 env split: move agent-intent env entries from adapter_config.env into
-- agent_config.env; engine-routing env keys (HOME/CODEX_HOME/HERMES_HOME/PATH)
-- stay in adapter_config.env. One-shot, additive on the agent side.
--
-- - Intent entries merge into agent_config.env at the ENV-KEY level; on a
--   same-key collision the pre-existing agent_config entry wins (mirrors
--   mergeAgentConfig priority where the agent side wins).
-- - agent_config.env is created only when at least one intent entry exists.
-- - adapter_config.env keeps only engine entries; the env key is removed
--   entirely when no engine entries remain. Rows whose env is missing or not
--   an object are untouched.
UPDATE "agents"
SET "agent_config" = CASE
    WHEN "split"."agent_intent_env" IS NOT NULL THEN
      COALESCE("agents"."agent_config", '{}'::jsonb) ||
      jsonb_build_object(
        'env',
        "split"."agent_intent_env" ||
        COALESCE(
          CASE
            WHEN jsonb_typeof("agents"."agent_config" -> 'env') = 'object'
            THEN "agents"."agent_config" -> 'env'
            ELSE '{}'::jsonb
          END,
          '{}'::jsonb
        )
      )
    ELSE "agents"."agent_config"
  END,
  "adapter_config" = CASE
    WHEN "split"."engine_env" IS NOT NULL THEN
      COALESCE("agents"."adapter_config", '{}'::jsonb) ||
      jsonb_build_object('env', "split"."engine_env")
    ELSE
      COALESCE("agents"."adapter_config", '{}'::jsonb) - 'env'
  END
FROM (
  SELECT
    "id",
    NULLIF(
      (
        SELECT jsonb_object_agg(k, v)
        FROM jsonb_each("agents"."adapter_config" -> 'env') AS e(k, v)
        WHERE k NOT IN ('HOME', 'CODEX_HOME', 'HERMES_HOME', 'PATH')
          AND v <> 'null'::jsonb
      ),
      '{}'::jsonb
    ) AS "agent_intent_env",
    NULLIF(
      (
        SELECT jsonb_object_agg(k, v)
        FROM jsonb_each("agents"."adapter_config" -> 'env') AS e(k, v)
        WHERE k IN ('HOME', 'CODEX_HOME', 'HERMES_HOME', 'PATH')
          AND v <> 'null'::jsonb
      ),
      '{}'::jsonb
    ) AS "engine_env"
  FROM "agents"
  WHERE jsonb_typeof("agents"."adapter_config" -> 'env') = 'object'
) AS "split"
WHERE "agents"."id" = "split"."id";
