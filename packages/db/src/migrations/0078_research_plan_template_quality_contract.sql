UPDATE "mission_plan_templates"
SET
	"instructions" = E'Split source gathering from synthesis and evidence-backed QA.\nRequire explicit source breadth and depth across the distinct official documentation surfaces relevant to the mission instead of one vague research task.\nRecord the search for contradictory, negative, or missing evidence, including when none is found.\nThe synthesis must distinguish fact, inference, and uncertainty; independent QA must reject missing breadth, depth, or unaddressed skeptical findings.\nA research output consumed downstream is an official work product.',
	"updated_at" = now()
WHERE "origin" = 'system_default'
	AND "key" = 'research-report-qa';
