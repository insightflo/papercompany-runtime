import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromDbPackage = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = requireFromDbPackage("postgres") as any;

type PluginEntityRow = {
  id: string;
  entity_type: string;
  scope_id: string | null;
  title: string | null;
  status: string | null;
  data: Record<string, unknown> | null;
};

type NativeDefinitionRow = {
  id: string;
  company_id: string;
  name: string;
};

type CompanyScopedRow = { id: string; company_id: string };

type StatusCount = { status: string | null; count: string | number | bigint };

type IdRelation = {
  pluginId: string;
  pluginName: string;
  pluginStatus: string;
  nativeId: string | null;
  nativeName: string | null;
  relation: "same" | "different-with-mapping" | "plugin-only";
};

const DEFAULT_REPORT_PATH = path.resolve(
  scriptDir,
  "../../../papercompany-artifacts/doc/plans/2026-06-11-workflow-engine-core-phase-b-dry-run.md",
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_RUN_STATUSES = new Set(["running"]);
const ACTIVE_STEP_STATUSES = new Set(["in_progress", "backlog"]);

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function getDbUrl(): string {
  const url = argValue("--database-url") ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL or --database-url is required for read-only dry-run");
  }
  return url;
}

function getReportPath(): string {
  return path.resolve(argValue("--out") ?? process.env.WORKFLOW_ENGINE_DRY_RUN_REPORT ?? DEFAULT_REPORT_PATH);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function entityName(row: PluginEntityRow): string {
  const data = asRecord(row.data);
  return textValue(data.name) ?? textValue(data.title) ?? row.title ?? row.id;
}

function entityCompanyId(row: PluginEntityRow): string | null {
  const data = asRecord(row.data);
  return textValue(data.companyId) ?? row.scope_id;
}

function dataId(row: PluginEntityRow, keys: string[]): string | null {
  const data = asRecord(row.data);
  for (const key of keys) {
    const value = textValue(data[key]);
    if (value) return value;
  }
  return null;
}

function countNumber(value: string | number | bigint | null | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusCountMap(rows: StatusCount[]): Map<string, number> {
  return new Map(rows.map((row) => [row.status ?? "(null)", countNumber(row.count)]));
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll("\n", "<br>")).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function summarizeCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
}

function collectUuidParseIssues(rows: PluginEntityRow[], label: string): string[] {
  const issues: string[] = [];
  for (const row of rows) {
    if (!UUID_RE.test(row.id)) issues.push(`${label}:${row.id}: entity id is not uuid`);
  }
  return issues;
}

function fkIssuesForRows(
  rows: PluginEntityRow[],
  label: string,
  field: string,
  targets: Map<string, string>,
): string[] {
  const issues: string[] = [];
  for (const row of rows) {
    const id = dataId(row, [field]);
    if (!id) continue;
    const companyId = entityCompanyId(row);
    const targetCompanyId = targets.get(id);
    if (!targetCompanyId) {
      issues.push(`${label}:${row.id}: ${field}=${id} missing target row`);
    } else if (companyId && targetCompanyId !== companyId) {
      issues.push(`${label}:${row.id}: ${field}=${id} target company ${targetCompanyId} != source company ${companyId}`);
    }
  }
  return issues;
}

function normalizeUtcMinute(value: Date): string {
  const normalized = new Date(value);
  normalized.setUTCSeconds(0, 0);
  return normalized.toISOString();
}

function possibleScheduleSlotPreview(row: PluginEntityRow): string {
  const data = asRecord(row.data);
  const lastScheduled = textValue(data.lastScheduledRunAt);
  if (!lastScheduled) return "pending first native scheduler fire";
  const parsed = new Date(lastScheduled);
  if (Number.isNaN(parsed.getTime())) return "invalid lastScheduledRunAt; dry-run only";
  return normalizeUtcMinute(parsed);
}

async function main() {
  const dbUrl = getDbUrl();
  const reportPath = getReportPath();
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

  try {
    await sql.unsafe("BEGIN READ ONLY");

    const pluginRows = await sql<PluginEntityRow[]>`
      select id::text, entity_type, scope_id, title, status, data
      from plugin_entities
      where entity_type in ('workflow-definition', 'workflow-run', 'workflow-step-run', 'idempotency-key')
      order by entity_type, created_at, id
    `;
    const nativeDefinitions = await sql<NativeDefinitionRow[]>`
      select id::text, company_id::text, name
      from workflow_definitions
      order by name, id
    `;
    const projects = await sql<CompanyScopedRow[]>`select id::text, company_id::text from projects`;
    const goals = await sql<CompanyScopedRow[]>`select id::text, company_id::text from goals`;
    const issues = await sql<CompanyScopedRow[]>`select id::text, company_id::text from issues`;
    const runStatusRows = await sql<StatusCount[]>`
      select status, count(*) as count
      from plugin_entities
      where entity_type = 'workflow-run'
      group by status
      order by status
    `;
    const stepStatusRows = await sql<StatusCount[]>`
      select status, count(*) as count
      from plugin_entities
      where entity_type = 'workflow-step-run'
      group by status
      order by status
    `;

    await sql.unsafe("COMMIT");

    const definitions = pluginRows.filter((row) => row.entity_type === "workflow-definition");
    const runs = pluginRows.filter((row) => row.entity_type === "workflow-run");
    const stepRuns = pluginRows.filter((row) => row.entity_type === "workflow-step-run");
    const idempotencyKeys = pluginRows.filter((row) => row.entity_type === "idempotency-key");

    const nativeById = new Map(nativeDefinitions.map((row) => [row.id, row]));
    const nativeByName = new Map<string, NativeDefinitionRow[]>();
    for (const row of nativeDefinitions) {
      const list = nativeByName.get(row.name) ?? [];
      list.push(row);
      nativeByName.set(row.name, list);
    }

    const relations: IdRelation[] = definitions.map((definition) => {
      const name = entityName(definition);
      const sameId = nativeById.get(definition.id);
      if (sameId) {
        return {
          pluginId: definition.id,
          pluginName: name,
          pluginStatus: definition.status ?? "(null)",
          nativeId: sameId.id,
          nativeName: sameId.name,
          relation: "same",
        };
      }
      const sameName = (nativeByName.get(name) ?? [])[0];
      if (sameName) {
        return {
          pluginId: definition.id,
          pluginName: name,
          pluginStatus: definition.status ?? "(null)",
          nativeId: sameName.id,
          nativeName: sameName.name,
          relation: "different-with-mapping",
        };
      }
      return {
        pluginId: definition.id,
        pluginName: name,
        pluginStatus: definition.status ?? "(null)",
        nativeId: null,
        nativeName: null,
        relation: "plugin-only",
      };
    });

    const pluginDefinitionIds = new Set(definitions.map((row) => row.id));
    const pluginDefinitionNames = new Set(definitions.map(entityName));
    const nativeOnlyDefinitions = nativeDefinitions.filter((row) => !pluginDefinitionIds.has(row.id) && !pluginDefinitionNames.has(row.name));
    const relationSummary = {
      same: relations.filter((row) => row.relation === "same").length,
      differentWithMapping: relations.filter((row) => row.relation === "different-with-mapping").length,
      pluginOnly: relations.filter((row) => row.relation === "plugin-only").length,
      nativeOnly: nativeOnlyDefinitions.length,
      duplicateName: relations.filter((row) => row.relation === "different-with-mapping").length,
    };

    const runStatusCounts = statusCountMap(runStatusRows);
    const stepStatusCounts = statusCountMap(stepStatusRows);
    const activeRunBlockers = [...runStatusCounts.entries()]
      .filter(([status]) => ACTIVE_RUN_STATUSES.has(status))
      .reduce((sum, [, count]) => sum + count, 0);
    const activeStepBlockers = [...stepStatusCounts.entries()]
      .filter(([status]) => ACTIVE_STEP_STATUSES.has(status))
      .reduce((sum, [, count]) => sum + count, 0);

    const projectMap = new Map(projects.map((row) => [row.id, row.company_id]));
    const goalMap = new Map(goals.map((row) => [row.id, row.company_id]));
    const issueMap = new Map(issues.map((row) => [row.id, row.company_id]));

    const uuidIssues = [
      ...collectUuidParseIssues(definitions, "workflow-definition"),
      ...collectUuidParseIssues(runs, "workflow-run"),
      ...collectUuidParseIssues(stepRuns, "workflow-step-run"),
    ];
    const fkIssues = [
      ...fkIssuesForRows(definitions, "workflow-definition", "projectId", projectMap),
      ...fkIssuesForRows(definitions, "workflow-definition", "goalId", goalMap),
      ...fkIssuesForRows(runs, "workflow-run", "parentIssueId", issueMap),
      ...fkIssuesForRows(runs, "workflow-run", "projectId", projectMap),
      ...fkIssuesForRows(runs, "workflow-run", "goalId", goalMap),
    ];

    const runDefinitionRefs = new Map<string, number>();
    for (const run of runs) {
      const ref = dataId(run, ["workflowId", "workflowDefinitionId", "definitionId"]);
      if (!ref) continue;
      runDefinitionRefs.set(ref, (runDefinitionRefs.get(ref) ?? 0) + 1);
    }
    const pluginOnlyArchived = definitions.filter((definition) => {
      const relation = relations.find((row) => row.pluginId === definition.id);
      return relation?.relation === "plugin-only" && definition.status === "archived";
    });
    const archivedReferenceRows = pluginOnlyArchived.map((definition) => [
      definition.id,
      entityName(definition),
      runDefinitionRefs.get(definition.id) ?? 0,
      (runDefinitionRefs.get(definition.id) ?? 0) > 0 ? "historical-run-referenced" : "unreferenced-archive-export-only",
    ]);

    const scheduledDefinitions = definitions.filter((definition) => textValue(asRecord(definition.data).schedule));
    const slotPreviewRows = scheduledDefinitions.map((definition) => {
      const data = asRecord(definition.data);
      return [
        definition.id,
        entityName(definition),
        textValue(data.schedule) ?? "",
        textValue(data.timezone) ?? "UTC?",
        possibleScheduleSlotPreview(definition),
      ];
    });

    const blocked = activeRunBlockers > 0 || activeStepBlockers > 0 || uuidIssues.length > 0 || fkIssues.length > 0;
    const now = new Date().toISOString();
    const lines = [
      "# Workflow Engine Core Phase B Migration Dry-Run Report",
      "",
      `Generated: ${now}`,
      "",
      "This report is read-only. It queries current plugin/native workflow rows and does not insert, update, or delete data.",
      "",
      "## Summary",
      "",
      markdownTable(
        ["metric", "value"],
        [
          ["plugin workflow definitions", definitions.length],
          ["plugin workflow runs", runs.length],
          ["plugin workflow step-runs", stepRuns.length],
          ["plugin idempotency keys", idempotencyKeys.length],
          ["native workflow definitions", nativeDefinitions.length],
          ["active run blockers", activeRunBlockers],
          ["active step blockers", activeStepBlockers],
          ["uuid parse issues", uuidIssues.length],
          ["FK validity issues", fkIssues.length],
          ["blocked", blocked ? "true" : "false"],
        ],
      ),
      "",
      "## Definition relation summary",
      "",
      "```json",
      JSON.stringify(relationSummary, null, 2),
      "```",
      "",
      markdownTable(
        ["plugin_definition_id", "plugin_name", "plugin_status", "native_definition_id", "native_name", "relation"],
        relations.map((row) => [
          row.pluginId,
          row.pluginName,
          row.pluginStatus,
          row.nativeId ?? "—",
          row.nativeName ?? "—",
          row.relation,
        ]),
      ),
      "",
      "## Native-only definitions",
      "",
      nativeOnlyDefinitions.length > 0
        ? markdownTable(["native_definition_id", "company_id", "name"], nativeOnlyDefinitions.map((row) => [row.id, row.company_id, row.name]))
        : "None.",
      "",
      "## Legacy status counts",
      "",
      `Workflow runs: ${summarizeCounts(runStatusCounts)}`,
      "",
      `Workflow step-runs: ${summarizeCounts(stepStatusCounts)}`,
      "",
      "## Active legacy blockers",
      "",
      markdownTable(
        ["entity/status", "count", "decision"],
        [
          ["workflow-run/running", runStatusCounts.get("running") ?? 0, "block migration until drained or operator-aborted"],
          ["workflow-step-run/in_progress", stepStatusCounts.get("in_progress") ?? 0, "block migration until drained or operator-aborted"],
          ["workflow-step-run/backlog", stepStatusCounts.get("backlog") ?? 0, "block migration until parent run ownership is resolved"],
        ],
      ),
      "",
      "## FK validity checks",
      "",
      fkIssues.length > 0 ? fkIssues.map((issue) => `- ${issue}`).join("\n") : "No stale or cross-company FK references detected for projectId, goalId, parentIssueId fields present in plugin data.",
      "",
      "## UUID parse checks",
      "",
      uuidIssues.length > 0 ? uuidIssues.map((issue) => `- ${issue}`).join("\n") : "All legacy plugin definition/run/step entity IDs parse as UUID.",
      "",
      "## Plugin-only archived definition references",
      "",
      archivedReferenceRows.length > 0
        ? markdownTable(["plugin_definition_id", "name", "historical_run_refs", "decision"], archivedReferenceRows)
        : "No plugin-only archived definitions detected.",
      "",
      "## Scheduled slot preview",
      "",
      "Scheduled slot uniqueness must use UTC `scheduled_at` minute buckets. This preview is informational only and does not claim slots.",
      "",
      slotPreviewRows.length > 0
        ? markdownTable(["plugin_definition_id", "name", "schedule", "timezone", "preview_utc_scheduled_at_or_state"], slotPreviewRows)
        : "No scheduled plugin definitions detected.",
      "",
      "## Rollback / mutation note",
      "",
      "Phase B schema additions are additive. This script performed no migration mutation. Actual dirty-data migration remains blocked until active legacy records are drained/operator-aborted and a separate Phase G migration is approved.",
      "",
    ];

    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, lines.join("\n"), "utf8");

    console.log(JSON.stringify({
      reportPath,
      definitions: definitions.length,
      runs: runs.length,
      stepRuns: stepRuns.length,
      idempotencyKeys: idempotencyKeys.length,
      relationSummary,
      activeRunBlockers,
      activeStepBlockers,
      uuidIssues: uuidIssues.length,
      fkIssues: fkIssues.length,
      blocked,
    }, null, 2));
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
