import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { companies, issues, missions, toolDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { loadToolRecoveryBriefFacts } from "../services/missions/tool-recovery-brief-facts.js";
import { renderToolRecoveryBriefFacts } from "../services/missions/tool-recovery-brief-render.js";

const recovery = { version: 1, sameRunRetry: "forbidden", idempotencyKey: "entry slug",
  statusLookup: { instruction: "Look up entry status with API_TOKEN=DECL_SECRET first", toolName: "status-tool" },
  reconcile: "operator", installPath: "/srv/tools/publish", stateLocation: "/srv/state/publish.json",
  notes: ["CMS dispatch may apply after the 15s timeout"] };

// Catches: declaration not shown, invalid declaration throwing, secret leakage, and metadata becoming execution authority.
describeQualityDb("declared tool recovery metadata in brief (display only)", () => {
  let f: Awaited<ReturnType<typeof createQualityTestDb>>;
  const roots: string[] = [];
  beforeAll(async () => { f = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await f?.close(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
  async function input(adapterConfig: Record<string, unknown>, language = "en") {
    const s = await seedToolRecoveryScenario({ db: f.db, artifactExists: false }); roots.push(s.tempRoot);
    await f.db.update(companies).set({ defaultLanguage: language }).where(eq(companies.id, s.companyId));
    const [mission] = await f.db.select().from(missions).where(eq(missions.id, s.missionId));
    const [oversightIssue] = await f.db.select().from(issues).where(eq(issues.id, s.oversightIssueId));
    const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    await f.db.insert(toolDefinitions).values({ companyId: mission.companyId, name: "publish", adapterType: "builtin", adapterConfig });
    const step = { id: stepRun.stepId, name: "publish", dependencies: [], agentId: "", toolNames: ["publish"] };
    return f.db.transaction(tx => loadToolRecoveryBriefFacts(tx as never, { mission, oversightIssue, run, stepRun, step, workflowName: "wf" }));
  }

  it("renders a valid declaration as a sanitized display-only section", async () => {
    const facts = await input({ command: "node publish.mjs", env: { API_TOKEN: "DECL_SECRET" }, recovery });
    const text = renderToolRecoveryBriefFacts(facts);
    expect(text).toContain("## Declared tool recovery metadata");
    expect(text).toContain("display only");
    for (const v of ['"sameRunRetry":"forbidden"', '"reconcile":"operator"', "/srv/state/publish.json", "15s timeout", "status-tool"])
      expect(text).toContain(v);
    expect(text).not.toContain("DECL_SECRET");
  });

  it("renders Korean section header and invalid declaration diagnostics without throwing", async () => {
    const facts = await input({ command: "x", recovery: { version: 2, retryCommand: "rm -rf /" } }, "ko");
    const text = renderToolRecoveryBriefFacts(facts);
    expect(text).toContain("## 도구가 선언한 복구 정보");
    expect(text).toContain('"status":"invalid"');
    expect(text).not.toContain("rm -rf");
  });

  it("marks tools without a declaration as absent", async () => {
    const text = renderToolRecoveryBriefFacts(await input({ command: "x" }));
    expect(text).toContain('"status":"absent"');
  });
});

// §5.8: declared metadata must never become retry/branch/completion authority.
it("only display modules import the recovery metadata parser", () => {
  const root = join(import.meta.dirname, "..");
  const allowed = new Set(["services/missions/tool-recovery-declared-display.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "__tests__") walk(path); continue; }
      if (!name.endsWith(".ts")) continue;
      const rel = relative(root, path);
      const src = readFileSync(path, "utf8");
      if (/parseToolRecoveryMetadata|toolRecoveryMetadataV1|tool-recovery-declared-display/.test(src)
        && !allowed.has(rel) && rel !== "services/missions/tool-recovery-brief-facts.ts") offenders.push(rel);
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
  // The facts loader may only pass the display projection to the renderer; it must not branch on its fields.
  const facts = readFileSync(join(root, "services/missions/tool-recovery-brief-facts.ts"), "utf8");
  expect(facts).not.toMatch(/sameRunRetry|reconcile\s*===|statusLookup\./);
});
