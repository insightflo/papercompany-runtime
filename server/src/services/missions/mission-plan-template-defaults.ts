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
    key: "publication-verify",
    name: "Publication → verify",
    selectionDescription: "Use when granted tools declare publication and publication-verify artifact roles.",
    instructions: [
      "Assign a tool with artifactContract.role publication to an action unit and a tool with role publication-verify to a downstream qa unit; declare each unit's type explicitly.",
      "The verifier depends on the publication unit and binds the toolArgs key declared by artifactContract.consumerParams.receipt to {$steps.<publication-unit-id>.workProductPath}.",
      "Never use a guessed URL or direct curl instead of the registered publication result.",
      "Use a structural tool gate only when adapterConfig.capabilities explicitly contains structural_validation_v1; tool names do not establish capabilities or artifact roles.",
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
