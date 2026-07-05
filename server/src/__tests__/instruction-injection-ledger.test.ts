import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentInstructionInjections,
  agents,
  companies,
  createDb,
  issueExecutionCards,
  issues,
} from "@paperclipai/db";
import { applyInstructionInjectionLedger } from "../services/instruction-injection-ledger.js";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("instruction injection ledger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instruction-ledger-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    await db.delete(agentInstructionInjections);
    await db.delete(issueExecutionCards);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithCard() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Instruction Co",
      issuePrefix: "INS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run with card",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const card = buildWorkflowIssueExecutionCard({
      title: "Run with card",
      description: "Produce output.\n[ARTIFACT]: <absolute path>",
      companyId,
      issueId,
      workflowDefinitionId: randomUUID(),
      workflowRunId: randomUUID(),
      step: { id: "produce", dependencies: [], graphWorkProductRequired: true },
      isQaStep: false,
    });
    await db.insert(issueExecutionCards).values({
      companyId,
      issueId,
      contentHash: hashStructuredValue(card),
      cardJson: card,
    });
    return { companyId, agentId, issueId };
  }

  it("uses full instructions first and compact instructions on the same hash later", async () => {
    const seeded = await seedIssueWithCard();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instructions-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Important operating manual.", "utf8");

    const firstContext: Record<string, unknown> = {};
    await applyInstructionInjectionLedger({
      db,
      context: firstContext,
      agent: { id: seeded.agentId, companyId: seeded.companyId, adapterType: "codex_local" },
      issueId: seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: dir,
    });
    const secondContext: Record<string, unknown> = {};
    await applyInstructionInjectionLedger({
      db,
      context: secondContext,
      agent: { id: seeded.agentId, companyId: seeded.companyId, adapterType: "codex_local" },
      issueId: seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: dir,
    });

    expect(firstContext.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    expect(secondContext.paperclipInstructionInjection).toMatchObject({ mode: "compact" });
    const [row] = await db
      .select()
      .from(agentInstructionInjections)
      .where(eq(agentInstructionInjections.issueId, seeded.issueId));
    expect(row?.injectionCount).toBe(2);
  });
});
