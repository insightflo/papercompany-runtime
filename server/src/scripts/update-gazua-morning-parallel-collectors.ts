import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, pluginEntities, plugins, toolDefinitions, workflowDefinitions } from "@paperclipai/db";
import {
  GAZUA_MORNING_COLLECTION_TOOLS,
  buildGazuaMorningParallelCollectionSteps,
} from "../services/workflow/gazua-collection-plan.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

const DEFAULT_COMPANY_ID = "9045933e-40ca-4a08-8dad-38a8a054bdf3";
const TOOL_ROOT = "/Users/kwak/Projects/ai/papercompany/papercompany-operations/scripts/paperclip-addon/gazua-tools";
const DASHBOARD_ROOT = "/Users/kwak/Projects/ai/gazua-dashboard";

type WorkflowRow = {
  id: string;
  name: string;
  stepsJson: WorkflowStep[];
};

type DbWithClient = ReturnType<typeof createDb> & {
  $client?: { end: () => Promise<void> };
};

function findPaperclipConfig(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, ".paperclip", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not find .paperclip/config.json. Set DATABASE_URL explicitly.");
}

function resolveConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const configPath = findPaperclipConfig(process.cwd());
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    database?: { port?: number; database?: string; user?: string; password?: string };
  };
  const database = config.database ?? {};
  return `postgres://${database.user ?? "paperclip"}:${database.password ?? "paperclip"}@127.0.0.1:${database.port ?? 54330}/${database.database ?? "paperclip"}`;
}

function toolDescription(toolName: string): string {
  switch (toolName) {
    case "collect-premarket-futures":
      return "Collect Gazua morning futures, overnight US context, SOX, BDRY, USD/KRW, and KOSPI proxy inputs into dashboard data/futures.";
    case "collect-blog-insights":
      return "Collect Gazua morning economic blog insight source material into dashboard data/insights.";
    case "collect-macro-data":
      return "Collect Gazua morning macro indicators into dashboard data/macro.";
    case "collect-metadata":
      return "Collect Gazua morning KRX corporate metadata into dashboard data/metadata.";
    case "collect-us-stockflow":
      return "Collect Gazua morning smart-money and US stockflow source reports into dashboard data/us-stockflow.";
    case "collect-memory-scfi":
      return "Collect Gazua morning memory spot, SCFI, and CCFI indicators into dashboard data/memory-trend and data/scfi-index.";
    case "collect-hbm-hbf":
      return "Collect Gazua morning HBM/HBF memory-chain notes into dashboard data/hbm-hbf.";
    case "collect-kr-futures-flow":
      return "Collect Gazua morning KR futures, investor-flow, ETF proxy, and positioning tape inputs into dashboard data/kr-futures-flow.";
    case "collect-market-calendar":
      return "Collect Gazua morning market catalyst calendar inputs into the dashboard runtime tree.";
    default:
      return `Collect Gazua morning input ${toolName}.`;
  }
}

function adapterConfig(kind: string): Record<string, unknown> {
  return {
    source: "tool-registry",
    command: `./venv/bin/python scripts/collect_morning_input.py --kind ${kind}`,
    workingDirectory: TOOL_ROOT,
    env: {
      GAZUA_DASHBOARD_ROOT: DASHBOARD_ROOT,
    },
    requiresApproval: false,
    instructions: "Run this collector as one isolated Gazua morning data input step. Do not call the aggregate collect-morning wrapper from this tool.",
  };
}

function toolEntityData(tool: (typeof GAZUA_MORNING_COLLECTION_TOOLS)[number]): Record<string, unknown> {
  const now = new Date().toISOString();
  const config = adapterConfig(tool.kind);
  return {
    name: tool.toolName,
    command: config.command,
    workingDirectory: config.workingDirectory,
    env: config.env,
    requiresApproval: false,
    argsSchema: {},
    description: toolDescription(tool.toolName),
    instructions: config.instructions,
    createdBy: "codex-gazua-morning-parallel-collectors",
    createdAt: now,
    updatedBy: "codex-gazua-morning-parallel-collectors",
    updatedAt: now,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const companyIdArg = process.argv.find((arg) => arg.startsWith("--company-id="));
  const companyId = companyIdArg?.slice("--company-id=".length) || DEFAULT_COMPANY_ID;
  const db = createDb(resolveConnectionString()) as DbWithClient;

  try {
    const [morning] = await db
      .select({
        id: workflowDefinitions.id,
        name: workflowDefinitions.name,
        stepsJson: workflowDefinitions.stepsJson,
      })
      .from(workflowDefinitions)
      .where(and(
        eq(workflowDefinitions.companyId, companyId),
        eq(workflowDefinitions.name, "gazua-morning"),
      ))
      .limit(1) as WorkflowRow[];
    if (!morning) {
      throw new Error(`gazua-morning workflow not found for company ${companyId}`);
    }

    const nextSteps = buildGazuaMorningParallelCollectionSteps(morning.stepsJson ?? []);
    const macroAndEvening = await db
      .select({
        name: workflowDefinitions.name,
        stepsJson: workflowDefinitions.stepsJson,
      })
      .from(workflowDefinitions)
      .where(and(
        eq(workflowDefinitions.companyId, companyId),
        inArray(workflowDefinitions.name, ["gazua-macro-sentinel", "gazua-evening"]),
      ));

    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      companyId,
      workflow: {
        id: morning.id,
        name: morning.name,
        beforeStepIds: morning.stepsJson.map((step) => step.id),
        afterStepIds: nextSteps.map((step) => step.id),
        collectionToolNames: GAZUA_MORNING_COLLECTION_TOOLS.map((tool) => tool.toolName),
      },
      referencedWorkflows: macroAndEvening.map((workflow) => ({
        name: workflow.name,
        stepIds: (workflow.stepsJson as WorkflowStep[]).map((step) => step.id),
        toolNames: (workflow.stepsJson as WorkflowStep[]).flatMap((step) => step.toolNames ?? (step.toolName ? [step.toolName] : [])),
      })),
    }, null, 2));

    if (!apply) return;

    const [toolRegistryPlugin] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.pluginKey, "insightflo.tool-registry"))
      .limit(1);
    if (!toolRegistryPlugin) {
      throw new Error("Tool Registry plugin is not installed; cannot create executable tool-config entities.");
    }

    for (const tool of GAZUA_MORNING_COLLECTION_TOOLS) {
      const [entity] = await db
        .insert(pluginEntities)
        .values({
          pluginId: toolRegistryPlugin.id,
          entityType: "tool-config",
          scopeKind: "company",
          scopeId: companyId,
          externalId: `${companyId}::${tool.toolName}`,
          title: tool.toolName,
          status: "active",
          data: toolEntityData(tool),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pluginEntities.pluginId, pluginEntities.entityType, pluginEntities.externalId],
          set: {
            title: tool.toolName,
            status: "active",
            data: toolEntityData(tool),
            updatedAt: new Date(),
          },
        })
        .returning({ id: pluginEntities.id });
      if (!entity) {
        throw new Error(`Failed to upsert tool-config entity for ${tool.toolName}`);
      }

      await db
        .insert(toolDefinitions)
        .values({
          companyId,
          name: tool.toolName,
          description: toolDescription(tool.toolName),
          inputSchema: {},
          adapterType: "builtin",
          adapterConfig: {
            ...adapterConfig(tool.kind),
            legacyPluginEntityId: entity.id,
          },
          enabled: true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [toolDefinitions.companyId, toolDefinitions.name],
          set: {
            description: toolDescription(tool.toolName),
            inputSchema: {},
            adapterType: "builtin",
            adapterConfig: {
              ...adapterConfig(tool.kind),
              legacyPluginEntityId: entity.id,
            },
            enabled: true,
            updatedAt: new Date(),
          },
        });
    }

    await db
      .update(workflowDefinitions)
      .set({
        stepsJson: nextSteps,
        updatedAt: new Date(),
      })
      .where(and(
        eq(workflowDefinitions.id, morning.id),
        eq(workflowDefinitions.companyId, companyId),
      ));

    console.log(JSON.stringify({
      status: "updated",
      workflowId: morning.id,
      upsertedTools: GAZUA_MORNING_COLLECTION_TOOLS.map((tool) => tool.toolName),
      toolRegistryPluginEntityScope: `${companyId}::*`,
    }, null, 2));
  } finally {
    await db.$client?.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
