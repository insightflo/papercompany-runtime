SELECT pg_advisory_xact_lock(870087001::bigint);
--> statement-breakpoint
ALTER TABLE "agent_api_keys"
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_api_keys"
  ADD COLUMN IF NOT EXISTS "scope_config" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_api_keys_responsible_user_id_user_id_fk'
      AND conrelid = 'agent_api_keys'::regclass
  ) THEN
    ALTER TABLE "agent_api_keys"
      ADD CONSTRAINT "agent_api_keys_responsible_user_id_user_id_fk"
      FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_api_keys_responsible_user_idx"
  ON "agent_api_keys" USING btree ("responsible_user_id");
--> statement-breakpoint
CREATE TEMP TABLE _paperclip_0087_agent_key_decisions (
  key_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  key_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('backfill', 'revoke', 'preserve_revoked')),
  reason_codes jsonb NOT NULL,
  candidates jsonb NOT NULL,
  resolved_user_id text,
  requires_operator_action boolean NOT NULL,
  report_activity_id uuid
) ON COMMIT DROP;
--> statement-breakpoint
WITH direct_evidence AS (
  SELECT k.id AS key_id, al.actor_id::text AS user_id, 'direct_key_created'::text AS source
  FROM agent_api_keys k
  JOIN activity_log al
    ON al.action = 'agent.key_created'
   AND al.entity_type = 'agent'
   AND al.entity_id = k.agent_id::text
   AND al.company_id = k.company_id
   AND al.actor_type = 'user'
   AND al.details->>'keyId' = k.id::text
), join_evidence AS (
  SELECT k.id AS key_id, approved.actor_id::text AS user_id, 'join_claim'::text AS source
  FROM agent_api_keys k
  JOIN activity_log claim
    ON claim.action = 'agent_api_key.claimed'
   AND claim.entity_type = 'agent_api_key'
   AND claim.entity_id = k.id::text
   AND claim.company_id = k.company_id
   AND claim.details->>'agentId' = k.agent_id::text
  JOIN join_requests jr
    ON claim.details->>'joinRequestId' = jr.id::text
   AND jr.request_type = 'agent'
   AND jr.status = 'approved'
   AND jr.approved_at IS NOT NULL
   AND jr.claim_secret_consumed_at IS NOT NULL
   AND jr.company_id = k.company_id
   AND jr.created_agent_id = k.agent_id
  JOIN activity_log approved
    ON approved.action = 'join.approved'
   AND approved.entity_type = 'join_request'
   AND approved.entity_id = jr.id::text
   AND approved.company_id = jr.company_id
   AND approved.actor_type = 'user'
   AND approved.actor_id = jr.approved_by_user_id
), candidate_evidence AS (
  SELECT key_id, user_id, source FROM direct_evidence
  UNION
  SELECT key_id, user_id, source FROM join_evidence
), candidate_eligibility AS (
  SELECT
    ce.key_id,
    ce.user_id,
    array_agg(ce.source ORDER BY ce.source COLLATE "C") AS sources,
    (u.id IS NOT NULL) AS user_exists,
    EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.company_id = k.company_id
        AND cm.principal_type = 'user'
        AND cm.principal_id = ce.user_id
    ) AS membership_exists,
    EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.company_id = k.company_id
        AND cm.principal_type = 'user'
        AND cm.principal_id = ce.user_id
        AND cm.status = 'active'
    ) AS active_membership,
    EXISTS (
      SELECT 1 FROM instance_user_roles r
      WHERE r.user_id = ce.user_id
        AND r.role = 'instance_admin'
    ) AS instance_admin
  FROM candidate_evidence ce
  JOIN agent_api_keys k ON k.id = ce.key_id
  LEFT JOIN "user" u ON u.id = ce.user_id
  GROUP BY ce.key_id, ce.user_id, k.company_id, u.id
), candidate_rollup AS (
  SELECT
    c.key_id,
    jsonb_agg(
      jsonb_build_object(
        'userId', c.user_id,
        'sources', to_jsonb(c.sources),
        'eligible', c.user_exists AND (c.active_membership OR c.instance_admin),
        'eligibilityReasonCodes', CASE
          WHEN NOT c.user_exists THEN jsonb_build_array('user_not_found')
          WHEN c.active_membership AND c.instance_admin THEN jsonb_build_array('active_company_membership', 'instance_admin')
          WHEN c.active_membership THEN jsonb_build_array('active_company_membership')
          WHEN c.membership_exists AND c.instance_admin THEN jsonb_build_array('company_membership_inactive', 'instance_admin')
          WHEN c.membership_exists THEN jsonb_build_array('company_membership_inactive')
          WHEN c.instance_admin THEN jsonb_build_array('company_membership_missing', 'instance_admin')
          ELSE jsonb_build_array('company_membership_missing')
        END
      ) ORDER BY c.user_id COLLATE "C"
    ) AS candidates,
    count(*) FILTER (WHERE c.user_exists AND (c.active_membership OR c.instance_admin))::int AS eligible_candidate_count,
    (array_agg(c.user_id ORDER BY c.user_id COLLATE "C") FILTER (WHERE c.user_exists AND (c.active_membership OR c.instance_admin)))[1] AS resolved_user_id
  FROM candidate_eligibility c
  GROUP BY c.key_id
), per_key_decision AS (
  SELECT
    k.id AS key_id,
    k.company_id,
    k.agent_id,
    k.name AS key_name,
    CASE
      WHEN k.revoked_at IS NOT NULL THEN 'preserve_revoked'
      WHEN COALESCE(r.eligible_candidate_count, 0) = 1 THEN 'backfill'
      ELSE 'revoke'
    END AS decision,
    CASE
      WHEN k.revoked_at IS NOT NULL THEN jsonb_build_array('already_revoked')
      WHEN COALESCE(r.eligible_candidate_count, 0) = 1 THEN jsonb_build_array('exactly_one_eligible_candidate')
      WHEN r.key_id IS NULL THEN jsonb_build_array('no_provenance')
      WHEN r.eligible_candidate_count = 0 THEN jsonb_build_array('no_eligible_candidate')
      ELSE jsonb_build_array('conflicting_eligible_candidates')
    END AS reason_codes,
    COALESCE(r.candidates, '[]'::jsonb) AS candidates,
    CASE WHEN k.revoked_at IS NULL AND r.eligible_candidate_count = 1 THEN r.resolved_user_id ELSE NULL END AS resolved_user_id,
    (k.revoked_at IS NULL AND COALESCE(r.eligible_candidate_count, 0) <> 1) AS requires_operator_action,
    COALESCE(existing.id, gen_random_uuid()) AS report_activity_id
  FROM agent_api_keys k
  LEFT JOIN candidate_rollup r ON r.key_id = k.id
  LEFT JOIN LATERAL (
    SELECT existing.id
    FROM activity_log existing
    WHERE existing.company_id = k.company_id
      AND existing.actor_type = 'system'
      AND existing.actor_id = 'migration:0087_agent_api_keys_responsibility_scope'
      AND existing.action = 'agent_api_key.responsibility_migration_reported'
      AND existing.entity_type = 'agent_api_key'
      AND existing.entity_id = k.id::text
      AND existing.agent_id = k.agent_id
    ORDER BY existing.id::text COLLATE "C"
    LIMIT 1
  ) existing ON true
  WHERE k.responsible_user_id IS NULL
)
INSERT INTO pg_temp._paperclip_0087_agent_key_decisions (
  key_id, company_id, agent_id, key_name, decision, reason_codes, candidates,
  resolved_user_id, requires_operator_action, report_activity_id
)
SELECT key_id, company_id, agent_id, key_name, decision, reason_codes, candidates,
  resolved_user_id, requires_operator_action, report_activity_id
FROM per_key_decision;
--> statement-breakpoint
INSERT INTO activity_log (
  id, company_id, actor_type, actor_id, action,
  entity_type, entity_id, agent_id, details
)
SELECT
  d.report_activity_id,
  d.company_id,
  'system',
  'migration:0087_agent_api_keys_responsibility_scope',
  'agent_api_key.responsibility_migration_reported',
  'agent_api_key',
  d.key_id::text,
  d.agent_id,
  jsonb_build_object(
    'schemaVersion', 1,
    'migration', '0087_agent_api_keys_responsibility_scope',
    'generatedAt', transaction_timestamp(),
    'key', jsonb_build_object(
      'keyId', d.key_id,
      'companyId', d.company_id,
      'agentId', d.agent_id,
      'keyName', d.key_name,
      'decision', d.decision,
      'reasonCodes', d.reason_codes,
      'candidates', d.candidates,
      'resolvedUserId', d.resolved_user_id,
      'requiresOperatorAction', d.requires_operator_action
    )
  )
FROM pg_temp._paperclip_0087_agent_key_decisions d
WHERE NOT EXISTS (
  SELECT 1 FROM activity_log existing
  WHERE existing.id = d.report_activity_id
);
--> statement-breakpoint
UPDATE agent_api_keys k
SET responsible_user_id = d.resolved_user_id
FROM pg_temp._paperclip_0087_agent_key_decisions d
WHERE k.id = d.key_id
  AND d.decision = 'backfill'
  AND d.resolved_user_id IS NOT NULL
  AND k.responsible_user_id IS NULL
  AND k.revoked_at IS NULL;
--> statement-breakpoint
WITH revoked AS (
  UPDATE agent_api_keys k
  SET revoked_at = transaction_timestamp()
  FROM pg_temp._paperclip_0087_agent_key_decisions d
  JOIN activity_log report
    ON report.id = d.report_activity_id
   AND report.action = 'agent_api_key.responsibility_migration_reported'
  WHERE k.id = d.key_id
    AND d.decision = 'revoke'
    AND k.responsible_user_id IS NULL
    AND k.revoked_at IS NULL
  RETURNING k.id AS key_id, k.company_id, k.agent_id
)
INSERT INTO activity_log (
  id, company_id, actor_type, actor_id, action,
  entity_type, entity_id, agent_id, details
)
SELECT
  gen_random_uuid(),
  revoked.company_id,
  'system',
  'migration:0087_agent_api_keys_responsibility_scope',
  'agent_api_key.revoked_by_responsibility_migration',
  'agent_api_key',
  revoked.key_id::text,
  revoked.agent_id,
  jsonb_build_object(
    'schemaVersion', 1,
    'migration', '0087_agent_api_keys_responsibility_scope',
    'keyId', revoked.key_id,
    'companyId', revoked.company_id,
    'agentId', revoked.agent_id
  )
FROM revoked
WHERE NOT EXISTS (
  SELECT 1 FROM activity_log existing
  WHERE existing.company_id = revoked.company_id
    AND existing.actor_type = 'system'
    AND existing.actor_id = 'migration:0087_agent_api_keys_responsibility_scope'
    AND existing.action = 'agent_api_key.revoked_by_responsibility_migration'
    AND existing.entity_type = 'agent_api_key'
    AND existing.entity_id = revoked.key_id::text
    AND existing.agent_id = revoked.agent_id
);
--> statement-breakpoint
DO $$
DECLARE
  unresolved_count integer;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM agent_api_keys
  WHERE revoked_at IS NULL AND responsible_user_id IS NULL;
  IF unresolved_count <> 0 THEN
    RAISE EXCEPTION '0087 invariant violated: active agent API key has no responsibility';
  END IF;
END $$;
