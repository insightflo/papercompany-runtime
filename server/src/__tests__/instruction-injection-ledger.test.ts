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
import {
  applyInstructionInjectionPolicy,
  loadInstructionsWithInlinedReferences,
} from "@paperclipai/adapter-utils/instructions";
import {
  confirmInstructionInjectionDelivery,
  forceFullInstructionInjection,
  invalidateInstructionInjectionSession,
  prepareInstructionInjection,
} from "../services/instruction-injection-ledger.js";
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

  async function prepareAndMarkDelivered(input: {
    seeded: Awaited<ReturnType<typeof seedIssueWithCard>>;
    dir: string;
    context: Record<string, unknown>;
    runId: string;
    providerSessionId: string | null;
  }) {
    const plan = await prepareInstructionInjection({
      db,
      context: input.context,
      agent: { id: input.seeded.agentId, companyId: input.seeded.companyId, adapterType: "codex_local" },
      issueId: input.seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: input.dir,
      runId: input.runId,
      providerSessionId: input.providerSessionId,
    });
    const loaded = await loadInstructionsWithInlinedReferences(path.join(input.dir, "AGENTS.md"));
    applyInstructionInjectionPolicy(loaded, input.context);
    return plan;
  }

  it("commits only after delivery and compacts only for the same provider session", async () => {
    const seeded = await seedIssueWithCard();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instructions-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Important operating manual.", "utf8");

    const firstContext: Record<string, unknown> = {};
    const firstPlan = await prepareAndMarkDelivered({
      seeded, dir, context: firstContext, runId: "run-1", providerSessionId: "session-1",
    });
    expect(firstContext.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    expect(await db.select().from(agentInstructionInjections)).toHaveLength(0);
    expect(await confirmInstructionInjectionDelivery({
      db, context: firstContext, plan: firstPlan, providerSessionId: "session-1", adapterProcessStarted: true,
    })).toBe(true);

    const secondContext: Record<string, unknown> = {};
    const secondPlan = await prepareAndMarkDelivered({
      seeded, dir, context: secondContext, runId: "run-2", providerSessionId: "session-1",
    });
    expect(secondContext.paperclipInstructionInjection).toMatchObject({ mode: "compact" });
    expect(await confirmInstructionInjectionDelivery({
      db, context: secondContext, plan: secondPlan, providerSessionId: "session-1", adapterProcessStarted: true,
    })).toBe(true);

    const [row] = await db
      .select()
      .from(agentInstructionInjections)
      .where(eq(agentInstructionInjections.issueId, seeded.issueId));
    expect(row?.injectionCount).toBe(2);
    expect(row?.lastInjectionJson).toMatchObject({ providerSessionId: "session-1", mode: "compact" });

    const newSessionContext: Record<string, unknown> = {};
    await prepareAndMarkDelivered({
      seeded, dir, context: newSessionContext, runId: "run-3", providerSessionId: "session-2",
    });
    expect(newSessionContext.paperclipInstructionInjection).toMatchObject({ mode: "full" });
  });

  it("does not mutate the ledger without matching preparation evidence and a started process", async () => {
    const seeded = await seedIssueWithCard();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instructions-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Important operating manual.", "utf8");
    const context: Record<string, unknown> = {};
    const plan = await prepareInstructionInjection({
      db,
      context,
      agent: { id: seeded.agentId, companyId: seeded.companyId, adapterType: "codex_local" },
      issueId: seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: dir,
      runId: "run-no-delivery",
      providerSessionId: "session-1",
    });
    expect(await confirmInstructionInjectionDelivery({
      db, context, plan, providerSessionId: "session-1", adapterProcessStarted: true,
    })).toBe(false);
    context.paperclipInstructionInjectionDelivery = {
      version: 1, state: "prepared", deliveryToken: "wrong", mode: "full",
      contentHash: plan?.contentHash, entryPath: plan?.entryPath,
    };
    expect(await confirmInstructionInjectionDelivery({
      db, context, plan, providerSessionId: "session-1", adapterProcessStarted: true,
    })).toBe(false);
    expect(await confirmInstructionInjectionDelivery({
      db, context, plan, providerSessionId: "session-1", adapterProcessStarted: false,
    })).toBe(false);
    expect(await db.select().from(agentInstructionInjections)).toHaveLength(0);
  });

  it("forces a provisional compact plan back to full after a late rotation", async () => {
    const seeded = await seedIssueWithCard();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instructions-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Important operating manual.", "utf8");

    const firstContext: Record<string, unknown> = {};
    const firstPlan = await prepareAndMarkDelivered({
      seeded, dir, context: firstContext, runId: "run-1", providerSessionId: "session-1",
    });
    await confirmInstructionInjectionDelivery({
      db, context: firstContext, plan: firstPlan, providerSessionId: "session-1", adapterProcessStarted: true,
    });

    const rotatedContext: Record<string, unknown> = {};
    const provisional = await prepareAndMarkDelivered({
      seeded, dir, context: rotatedContext, runId: "run-2", providerSessionId: "session-1",
    });
    expect(provisional?.mode).toBe("compact");
    const forced = forceFullInstructionInjection(rotatedContext, provisional);
    expect(forced?.mode).toBe("full");
    expect(rotatedContext.paperclipInstructionInjection).toMatchObject({ mode: "full" });

    const loaded = await loadInstructionsWithInlinedReferences(path.join(dir, "AGENTS.md"));
    applyInstructionInjectionPolicy(loaded, rotatedContext);
    expect(await confirmInstructionInjectionDelivery({
      db, context: rotatedContext, plan: forced, providerSessionId: "session-2", adapterProcessStarted: true,
    })).toBe(true);
    const [row] = await db.select().from(agentInstructionInjections);
    expect(row?.injectionCount).toBe(1);
    expect(row?.lastInjectionJson).toMatchObject({ providerSessionId: "session-2", mode: "full" });
  });

  it("forces full instructions after compact delivery is not confirmed", async () => {
    const seeded = await seedIssueWithCard();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ledger-instructions-"));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Important operating manual.", "utf8");

    const firstContext: Record<string, unknown> = {};
    const firstPlan = await prepareAndMarkDelivered({
      seeded, dir, context: firstContext, runId: "run-1", providerSessionId: "session-1",
    });
    await confirmInstructionInjectionDelivery({
      db, context: firstContext, plan: firstPlan, providerSessionId: "session-1", adapterProcessStarted: true,
    });

    const unconfirmedContext: Record<string, unknown> = {};
    const unconfirmedPlan = await prepareInstructionInjection({
      db,
      context: unconfirmedContext,
      agent: { id: seeded.agentId, companyId: seeded.companyId, adapterType: "codex_local" },
      issueId: seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: dir,
      runId: "run-2",
      providerSessionId: "session-1",
    });
    expect(unconfirmedPlan?.mode).toBe("compact");
    expect(await confirmInstructionInjectionDelivery({
      db,
      context: unconfirmedContext,
      plan: unconfirmedPlan,
      providerSessionId: "session-1",
      adapterProcessStarted: true,
    })).toBe(false);
    await invalidateInstructionInjectionSession({ db, plan: unconfirmedPlan });

    const recoveryPlan = await prepareInstructionInjection({
      db,
      context: {},
      agent: { id: seeded.agentId, companyId: seeded.companyId, adapterType: "codex_local" },
      issueId: seeded.issueId,
      adapterConfig: { instructionsFilePath: "AGENTS.md" },
      cwd: dir,
      runId: "run-3",
      providerSessionId: "session-1",
    });
    expect(recoveryPlan?.mode).toBe("full");
  });
});
