CREATE TABLE IF NOT EXISTS "mission_plan_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"selection_description" text NOT NULL,
	"instructions" text NOT NULL,
	"origin" text DEFAULT 'custom' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mission_plan_templates_company_key_uq"
	ON "mission_plan_templates" ("company_id", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mission_plan_templates_company_idx"
	ON "mission_plan_templates" ("company_id");
--> statement-breakpoint
INSERT INTO "mission_plan_templates" (
	"company_id", "key", "name", "selection_description", "instructions", "origin", "enabled"
)
SELECT c."id", defaults."key", defaults."name", defaults."selection_description", defaults."instructions", 'system_default', true
FROM "companies" c
CROSS JOIN (VALUES
	('research-report-qa', 'Research → report → QA', 'Use when a mission requires fresh findings or source evidence before producing a report.', E'Split source gathering from synthesis and evidence-backed QA.\nUse explicit coverage for independent queries or domains instead of one vague research task.\nA research output consumed downstream is an official work product.'),
	('durable-file-review', 'Durable file → review', 'Use when the mission produces a document, HTML page, PDF, presentation, spreadsheet, or other durable artifact.', E'The producer must register the durable artifact as an official work product.\nUse a producer → artifact QA → final outcome review chain.\nDownstream units consume the producer through {$steps.<producer-unit-id>.workProductPath}.'),
	('manual-onboarding-publish-verify', 'Manual onboarding publish → verify', 'Use when an approved manual must be published with manual-onboarding-publish and read back with manual-onboarding-verify.', E'Assign manual-onboarding-publish to one publisher and manual-onboarding-verify to a downstream QA unit.\nThe verifier consumes toolArgs.publishResultPath: {$steps.<publish-unit-id>.workProductPath}.\nNever use a guessed URL or direct curl instead of the registered publish result.\nTreat manual-onboarding-verify as an agent QA tool unless its registered adapterConfig.capabilities explicitly contains structural_validation_v1. A validator-like tool name is not structural capability evidence.'),
	('structural-validation-semantic-review', 'Structural validation → semantic review', 'Use when a machine-checkable contract has a granted validator with explicit structural capability, followed by meaning-focused QA.', E'Use a structural tool gate only for deterministic schema, ID, selector, status, hash, or URL contracts.\nThe registered tool must explicitly support structural_validation_v1 and return data.verdict.\nKeep coherence, factual accuracy, audience fit, and purpose fit in downstream agent QA.')
) AS defaults("key", "name", "selection_description", "instructions")
ON CONFLICT ("company_id", "key") DO NOTHING;
