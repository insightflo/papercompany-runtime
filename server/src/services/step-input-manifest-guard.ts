import fs from "node:fs/promises";
import path from "node:path";
import { buildPaperclipRuntimeBrief, joinPromptSections, renderTemplate } from "@paperclipai/adapter-utils";
import { parseObject } from "../adapters/utils.js";

const DEFAULT_HEARTBEAT_PROMPT =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. Never claim work by PATCHing an issue to in_progress; only POST /api/issues/{issueId}/checkout may move work into in_progress. Do not invent alternate completion routes; use PATCH /api/issues/{issueId} for done/blocked updates and POST /api/issues/{issueId}/release only to give work back. If no assignments are returned, exit the heartbeat.";

const NEGATED_SCAN_PATTERN =
  /\b(?:do not|don't|dont|never|avoid|must not|should not|instead of|rather than)\b.{0,80}\b(?:scan|search|inspect|read|walk|list)\b/;

const HISTORICAL_OR_QUOTED_CONTEXT_PATTERN =
  /\b(?:previous|prior|history|historical|handoff|quoted|quote|example|examples|forbidden|blocked|failed because|tried to)\b/;

const IMPERATIVE_PREFIX_PATTERN =
  /^(?:please\s+|must\s+|should\s+|need to\s+|you should\s+|go ahead and\s+|start by\s+|first,?\s+)?(?:scan|search|inspect|read|walk|list)\b/;

const BROAD_SCAN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "scan the entire repo",
    pattern: /\b(?:please\s+)?scan\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+(?:repo|repository)\b/,
  },
  {
    label: "scan the entire workspace",
    pattern: /\b(?:please\s+)?scan\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+workspace\b/,
  },
  {
    label: "search across the entire workspace",
    pattern: /\b(?:please\s+)?search\b.{0,60}\b(?:across\s+)?(?:the\s+)?(?:entire|whole)\s+workspace\b/,
  },
  {
    label: "search the entire codebase",
    pattern: /\b(?:please\s+)?search\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+codebase\b/,
  },
  {
    label: "inspect the whole repository",
    pattern: /\b(?:please\s+)?inspect\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+(?:repo|repository|codebase|workspace)\b/,
  },
  {
    label: "read the whole repository",
    pattern: /\b(?:please\s+)?read\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+(?:repo|repository|codebase|workspace)\b/,
  },
  {
    label: "walk the whole codebase",
    pattern: /\b(?:please\s+)?walk\b.{0,60}\b(?:the\s+)?(?:entire|whole)\s+(?:repo|repository|codebase|workspace)\b/,
  },
  {
    label: "list every file",
    pattern: /\b(?:please\s+)?list every file\b/,
  },
];

export interface StepInputManifestGuardResult {
  blocked: boolean;
  reason: string | null;
  matchedPhrase: string | null;
}

export async function evaluateStepInputManifestGuard(input: {
  adapterConfig: Record<string, unknown>;
  agent: Record<string, unknown> & { id: string; companyId: string; name?: string | null };
  runId: string;
  context: Record<string, unknown>;
  hasResumableSession: boolean;
  cwd: string;
}): Promise<StepInputManifestGuardResult> {
  const manifest = parseObject(input.context.paperclipStepInputManifest);
  const guardrails = parseObject(manifest.guardrails);
  const manifestInputs = parseObject(manifest.inputs);
  const workspace = parseObject(manifestInputs.workspace);
  const broadScanAllowed = guardrails.broadScanAllowed === true;
  const workspaceAvailable = workspace.available === true;

  if (!workspaceAvailable || broadScanAllowed) {
    return {
      blocked: false,
      reason: null,
      matchedPhrase: null,
    };
  }

  const bundle = await buildPromptBundle(input);
  const matchedPhrase = findBroadScanInstruction(bundle);

  if (!matchedPhrase) {
    return {
      blocked: false,
      reason: null,
      matchedPhrase: null,
    };
  }

  return {
    blocked: true,
    matchedPhrase,
    reason: `Step Input Manifest blocked broad scan instruction: "${matchedPhrase}"`,
  };
}

function findBroadScanInstruction(bundle: string) {
  const segments = bundle
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((segment) => segment.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (NEGATED_SCAN_PATTERN.test(segment)) continue;
    if (HISTORICAL_OR_QUOTED_CONTEXT_PATTERN.test(segment) && !IMPERATIVE_PREFIX_PATTERN.test(segment)) {
      continue;
    }
    for (const candidate of BROAD_SCAN_PATTERNS) {
      if (candidate.pattern.test(segment)) {
        return candidate.label;
      }
    }
  }

  return null;
}

async function buildPromptBundle(input: {
  adapterConfig: Record<string, unknown>;
  agent: Record<string, unknown> & { id: string; companyId: string; name?: string | null };
  runId: string;
  context: Record<string, unknown>;
  hasResumableSession: boolean;
  cwd: string;
}) {
  const promptTemplate = String(input.adapterConfig.promptTemplate ?? DEFAULT_HEARTBEAT_PROMPT).trim() || DEFAULT_HEARTBEAT_PROMPT;
  const bootstrapPromptTemplate = String(input.adapterConfig.bootstrapPromptTemplate ?? "").trim();
  const templateData = {
    agentId: input.agent.id,
    companyId: input.agent.companyId,
    runId: input.runId,
    company: { id: input.agent.companyId },
    agent: input.agent,
    run: { id: input.runId, source: "on_demand" },
    context: input.context,
  } satisfies Record<string, unknown>;

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt = input.hasResumableSession
    ? ""
    : bootstrapPromptTemplate.length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const instructions = await readInstructionsText({
    instructionsFilePath:
      typeof input.adapterConfig.instructionsFilePath === "string"
        ? input.adapterConfig.instructionsFilePath
        : null,
    cwd: input.cwd,
  });
  const runtimeBrief = buildPaperclipRuntimeBrief(input.context);

  return joinPromptSections([instructions, renderedBootstrapPrompt, runtimeBrief, renderedPrompt]);
}

async function readInstructionsText(input: {
  instructionsFilePath: string | null;
  cwd: string;
}) {
  const trimmed = input.instructionsFilePath?.trim() ?? "";
  if (!trimmed) return "";
  const resolvedPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(input.cwd, trimmed);
  try {
    const content = await fs.readFile(resolvedPath, "utf8");
    const dir = `${path.dirname(resolvedPath)}/`;
    return (
      `${content}\n\n` +
      `The above agent instructions were loaded from ${resolvedPath}. ` +
      `Resolve any relative file references from ${dir}.`
    );
  } catch {
    return "";
  }
}
