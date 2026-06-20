import type { WorkflowStep } from "./dag-engine.js";

export type GazuaMorningCollectionTool = {
  stepId: string;
  toolName: string;
  kind: string;
  name: string;
  description: string;
};

export const GAZUA_MORNING_COLLECTION_TOOLS: GazuaMorningCollectionTool[] = [
  {
    stepId: "collect-premarket-futures",
    toolName: "collect-premarket-futures",
    kind: "futures",
    name: "{$date} 선물/전일 미국장 컨텍스트 수집",
    description: "Collects premarket futures and overnight context into data/futures.",
  },
  {
    stepId: "collect-blog-insights",
    toolName: "collect-blog-insights",
    kind: "blog-insights",
    name: "{$date} 경제 블로그 인사이트 수집",
    description: "Collects source blog insight posts into data/insights.",
  },
  {
    stepId: "collect-macro-data",
    toolName: "collect-macro-data",
    kind: "macro",
    name: "{$date} 거시 지표 수집",
    description: "Collects global macro indicators into data/macro.",
  },
  {
    stepId: "collect-metadata",
    toolName: "collect-metadata",
    kind: "metadata",
    name: "{$date} KRX 종목 메타데이터 수집",
    description: "Collects KRX listing and metadata inputs into data/metadata.",
  },
  {
    stepId: "collect-us-stockflow",
    toolName: "collect-us-stockflow",
    kind: "us-stockflow",
    name: "{$date} 미국 스마트머니/고래 수급 수집",
    description: "Collects 13F smart-money stockflow reports into data/us-stockflow.",
  },
  {
    stepId: "collect-memory-scfi",
    toolName: "collect-memory-scfi",
    kind: "memory-scfi",
    name: "{$date} 메모리/SCFI 선행 지표 수집",
    description: "Collects memory spot, SCFI, and CCFI inputs into data/memory-trend and data/scfi-index.",
  },
  {
    stepId: "collect-hbm-hbf",
    toolName: "collect-hbm-hbf",
    kind: "hbm-hbf",
    name: "{$date} HBM/HBF 메모리 뉴스 수집",
    description: "Collects HBM/HBF memory-chain notes into data/hbm-hbf.",
  },
  {
    stepId: "collect-kr-futures-flow",
    toolName: "collect-kr-futures-flow",
    kind: "kr-futures-flow",
    name: "{$date} 한국 선물/수급 플로우 수집",
    description: "Collects KOSPI200 futures, ETF, investor-flow, and positioning tape inputs into data/kr-futures-flow.",
  },
  {
    stepId: "collect-market-calendar",
    toolName: "collect-market-calendar",
    kind: "market-calendar",
    name: "{$date} 시장 촉매 캘린더 수집",
    description: "Collects market calendar and catalyst inputs used by the morning report.",
  },
];

export const GAZUA_MORNING_COLLECTION_TOOL_NAMES = GAZUA_MORNING_COLLECTION_TOOLS.map(
  (tool) => tool.toolName,
);

export const GAZUA_MORNING_COLLECTION_STEP_IDS = GAZUA_MORNING_COLLECTION_TOOLS.map(
  (tool) => tool.stepId,
);

export const GAZUA_MORNING_ANALYSIS_STEP_IDS = [
  "collect-signals",
  "signal-analysis",
  "sector-rotation",
  "narrative-deep-dive",
  "market-analysis",
  "strategy",
  "strategy-summary",
  "blog",
  "materialize-html-report",
  "inspection",
];

export const GAZUA_MORNING_DATA_EVIDENCE_CONTRACT = `[2026-06-16 Gazua data evidence contract]
Before drawing conclusions, use /Users/kwak/Projects/ai/gazua-dashboard/data as the canonical evidence root, not only the workflow step comments.

Read the latest available source material by data category, then choose the categories relevant to this step's job:
- market context and positioning: futures, kr-futures-flow, metadata, market_signals, signals
- macro and regime: macro, regime, memory-trend, scfi-index
- narrative and sector/theme evidence: insights, hbm-hbf, market_signals, smart-money, us-stockflow
- handoff and dashboard state: gazua_handoff, gazua_dashboard, dashboard

Use the raw data to support report, narrative, regime, rotation, positioning, and risk judgments. Cite source_path and source_timestamp or file mtime for each material claim. If a category is missing, stale, or unusable, say "자료 부족/확인 불가" with the category name and continue with lower confidence; do not invent values from the report text itself.`;

const LEGACY_MORNING_COLLECTION_STEP_ID = "collect-market";
const LEGACY_MORNING_COLLECTION_TOOL_NAME = "collect-morning";
const KR_SIGNAL_TOOL_NAME = "collect-signals-kr";
const DATA_EVIDENCE_CONTRACT_MARKER = "Gazua data evidence contract";

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function replaceLegacyCollectionRefs(values: string[] | undefined): string[] {
  const next: string[] = [];
  for (const value of values ?? []) {
    if (value === LEGACY_MORNING_COLLECTION_STEP_ID) {
      next.push(...GAZUA_MORNING_COLLECTION_TOOLS.map((tool) => tool.stepId));
    } else {
      next.push(value);
    }
  }
  return dedupe(next);
}

function replaceLegacyToolRefs(values: string[] | undefined): string[] {
  const next: string[] = [];
  for (const value of values ?? []) {
    if (value === LEGACY_MORNING_COLLECTION_TOOL_NAME) {
      next.push(...GAZUA_MORNING_COLLECTION_TOOL_NAMES);
    } else {
      next.push(value);
    }
  }
  return dedupe(next);
}

function removeCollectionToolRefs(values: string[] | undefined): string[] {
  return dedupe((values ?? []).filter((value) =>
    value !== LEGACY_MORNING_COLLECTION_TOOL_NAME
    && !GAZUA_MORNING_COLLECTION_TOOL_NAMES.includes(value),
  ));
}

function buildCollectionStep(
  tool: GazuaMorningCollectionTool,
): WorkflowStep {
  return {
    id: tool.stepId,
    name: tool.name,
    title: tool.name,
    type: "tool",
    agentId: "",
    agentName: "",
    dependencies: [],
    dependsOn: [],
    toolName: tool.toolName,
    toolNames: [tool.toolName],
    toolArgs: {},
    description: tool.description,
  };
}

function withDataEvidenceContract(step: WorkflowStep): WorkflowStep {
  if (!GAZUA_MORNING_ANALYSIS_STEP_IDS.includes(step.id)) return step;

  const description = step.description?.trim() ?? "";
  if (description.includes(DATA_EVIDENCE_CONTRACT_MARKER)) return step;

  return {
    ...step,
    description: description
      ? `${description}\n\n${GAZUA_MORNING_DATA_EVIDENCE_CONTRACT}`
      : GAZUA_MORNING_DATA_EVIDENCE_CONTRACT,
  };
}

export function buildGazuaMorningParallelCollectionSteps(
  steps: WorkflowStep[],
): WorkflowStep[] {
  const collectionSteps = GAZUA_MORNING_COLLECTION_TOOLS.map((tool) =>
    buildCollectionStep(tool),
  );
  const migratedSteps: WorkflowStep[] = [];

  for (const step of steps) {
    if (step.id === LEGACY_MORNING_COLLECTION_STEP_ID) continue;
    if (GAZUA_MORNING_COLLECTION_STEP_IDS.includes(step.id)) continue;

    const nextDependencies = replaceLegacyCollectionRefs(step.dependencies);
    const nextDependsOn = replaceLegacyCollectionRefs(step.dependsOn ?? step.dependencies);
    const stepType = typeof step.type === "string" ? step.type.trim().toLowerCase() : "";
    const isAgentStep = stepType === "agent" || Boolean(step.agentName);
    const nextTools = isAgentStep ? removeCollectionToolRefs(step.tools) : replaceLegacyToolRefs(step.tools);
    const nextToolNames = isAgentStep ? removeCollectionToolRefs(step.toolNames) : replaceLegacyToolRefs(step.toolNames);
    const nextStep: WorkflowStep = {
      ...step,
      dependencies: nextDependencies,
      dependsOn: nextDependsOn,
    };

    if (step.tools) nextStep.tools = nextTools;
    if (step.toolNames) nextStep.toolNames = nextToolNames;
    if (isAgentStep && (
      step.toolName === LEGACY_MORNING_COLLECTION_TOOL_NAME
      || GAZUA_MORNING_COLLECTION_TOOL_NAMES.includes(step.toolName ?? "")
    )) {
      nextStep.toolName = "";
    }
    if (step.id === "collect-signals" && step.toolName === KR_SIGNAL_TOOL_NAME) {
      nextStep.dependencies = GAZUA_MORNING_COLLECTION_TOOLS.map((tool) => tool.stepId);
      nextStep.dependsOn = GAZUA_MORNING_COLLECTION_TOOLS.map((tool) => tool.stepId);
    }

    migratedSteps.push(withDataEvidenceContract(nextStep));
  }

  return [...collectionSteps, ...migratedSteps];
}
