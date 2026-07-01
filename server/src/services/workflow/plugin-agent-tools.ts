import type { Db } from "@paperclipai/db";
import { plugins } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export const RESEARCH_WORKBENCH_PLUGIN_KEY = "insightflo.research-workbench";
export const RESEARCH_WORKBENCH_SEARCH_TOOL_NAME = `${RESEARCH_WORKBENCH_PLUGIN_KEY}:research-search`;

const DEFAULT_WORKFLOW_PLUGIN_TOOL_NAMES = new Set([
  RESEARCH_WORKBENCH_SEARCH_TOOL_NAME,
]);

const RESEARCH_WORKBENCH_SEARCH_INSTRUCTIONS = [
  "Use this tool for web search, current external facts, source discovery, and research collection.",
  "Prefer it over ad-hoc browser or shell search when the workflow allows it.",
  "Pass the search text as `query`; set `maxResults` when the workflow needs a specific source count.",
].join(" ");

export type WorkflowPluginAgentTool = {
  name: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pluginId: string;
  pluginKey: string;
  instructions: string | null;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function workflowInstructionsForPluginTool(name: string): string | null {
  if (name === RESEARCH_WORKBENCH_SEARCH_TOOL_NAME) {
    return RESEARCH_WORKBENCH_SEARCH_INSTRUCTIONS;
  }
  return null;
}

export async function listDefaultWorkflowPluginAgentTools(db: Db): Promise<WorkflowPluginAgentTool[]> {
  const rows = await db
    .select({
      id: plugins.id,
      pluginKey: plugins.pluginKey,
      manifestJson: plugins.manifestJson,
    })
    .from(plugins)
    .where(eq(plugins.status, "ready"));

  const tools: WorkflowPluginAgentTool[] = [];
  for (const row of rows) {
    const manifest = recordValue(row.manifestJson);
    const declaredTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    for (const declaredTool of declaredTools) {
      const tool = recordValue(declaredTool);
      const bareName = stringValue(tool.name);
      if (!bareName) continue;

      const namespacedName = `${row.pluginKey}:${bareName}`;
      if (!DEFAULT_WORKFLOW_PLUGIN_TOOL_NAMES.has(namespacedName)) continue;

      tools.push({
        name: namespacedName,
        displayName: stringValue(tool.displayName) || namespacedName,
        description: stringValue(tool.description),
        inputSchema: recordValue(tool.parametersSchema),
        pluginId: row.id,
        pluginKey: row.pluginKey,
        instructions: workflowInstructionsForPluginTool(namespacedName),
      });
    }
  }

  return tools.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
