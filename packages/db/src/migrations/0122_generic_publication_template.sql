-- Retire only the historical system seed by its immutable key. Keep IDs, bodies,
-- custom copies and existing plan references intact; never inspect prose/tool names.
UPDATE "mission_plan_templates"
SET "enabled" = false, "updated_at" = now()
WHERE "key" = 'manual-onboarding-publish-verify'
  AND "origin" = 'system_default' AND "enabled" = true;
--> statement-breakpoint
INSERT INTO "mission_plan_templates" (
  "company_id", "key", "name", "selection_description", "instructions", "origin", "enabled"
)
SELECT "id", 'publication-verify', 'Publication → verify',
  'Use when granted tools declare publication and publication-verify artifact roles.',
  E'Assign a tool with artifactContract.role publication to an action unit and a tool with role publication-verify to a downstream qa unit; declare each unit\'s type explicitly.\nThe verifier depends on the publication unit and binds the toolArgs key declared by artifactContract.consumerParams.receipt to {$steps.<publication-unit-id>.workProductPath}.\nNever use a guessed URL or direct curl instead of the registered publication result.\nUse a structural tool gate only when adapterConfig.capabilities explicitly contains structural_validation_v1; tool names do not establish capabilities or artifact roles.',
  'system_default', true
FROM "companies"
ON CONFLICT ("company_id", "key") DO NOTHING;
