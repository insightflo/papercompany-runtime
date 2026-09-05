export const DEFAULT_MISSION_PLAN_TEMPLATES = [
  {
    key: "research-report-qa",
    name: "Research → report → QA",
    selectionDescription: "Use when a mission requires fresh findings or source evidence before producing a report.",
    instructions: [
      "Split source gathering from synthesis and evidence-backed QA.",
      "Require explicit source breadth and depth across the distinct official documentation surfaces relevant to the mission instead of one vague research task.",
      "Record the search for contradictory, negative, or missing evidence, including when none is found.",
      "The synthesis must distinguish fact, inference, and uncertainty; independent QA must reject missing breadth, depth, or unaddressed skeptical findings.",
      "A research output consumed downstream is an official work product.",
      "Declare expectedOutput / acceptanceCriteria / evidenceRequired on every producing unit so each materialized step carries a verifiable contract.",
    ].join("\n"),
  },
  {
    key: "durable-file-review",
    name: "Durable file → review",
    selectionDescription: "Use when the mission produces a document, HTML page, PDF, presentation, spreadsheet, or other durable artifact.",
    instructions: [
      "The producer must register the durable artifact as an official work product.",
      "Use a producer → artifact QA → final outcome review chain.",
      "Downstream units consume the producer through {$steps.<producer-unit-id>.workProductPath}.",
      "Declare expectedOutput / acceptanceCriteria / evidenceRequired on every producing unit so each materialized step carries a verifiable contract.",
    ].join("\n"),
  },
  {
    key: "manual-onboarding-publish-verify",
    name: "Manual onboarding publish → verify",
    selectionDescription: "Use when an approved manual must be published with manual-onboarding-publish and read back with manual-onboarding-verify.",
    instructions: [
      "Assign manual-onboarding-publish to one publisher and manual-onboarding-verify to a downstream QA unit.",
      "The verifier consumes toolArgs.publishResultPath: {$steps.<publish-unit-id>.workProductPath}.",
      "Never use a guessed URL or direct curl instead of the registered publish result.",
      "Treat manual-onboarding-verify as an agent QA tool unless its registered adapterConfig.capabilities explicitly contains structural_validation_v1. A validator-like tool name is not structural capability evidence.",
    ].join("\n"),
  },
  {
    key: "structural-validation-semantic-review",
    name: "Structural validation → semantic review",
    selectionDescription: "Use when a machine-checkable contract has a granted validator with explicit structural capability, followed by meaning-focused QA.",
    instructions: [
      "Use a structural tool gate only for deterministic schema, ID, selector, status, hash, or URL contracts.",
      "The registered tool must explicitly support structural_validation_v1 and return data.verdict.",
      "Keep coherence, factual accuracy, audience fit, and purpose fit in downstream agent QA.",
    ].join("\n"),
  },
] as const;

export const DEFAULT_MISSION_PLAN_TEMPLATE_KEYS = DEFAULT_MISSION_PLAN_TEMPLATES.map((template) => template.key);
