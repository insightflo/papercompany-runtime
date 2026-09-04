import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  evaluateSessionFileStaleness,
  FILE_VIEW_STALENESS_ROTATION_REASON,
  parseFileViewStalenessRotationPolicy,
} from "../services/file-view-session-staleness.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres file view staleness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

describe("parseFileViewStalenessRotationPolicy", () => {
  it("defaults to enabled when the config object is absent", () => {
    expect(parseFileViewStalenessRotationPolicy(undefined)).toEqual({ enabled: true });
    expect(parseFileViewStalenessRotationPolicy({})).toEqual({ enabled: true });
    expect(parseFileViewStalenessRotationPolicy({ heartbeat: {} })).toEqual({ enabled: true });
  });

  it("returns enabled:false only when explicitly disabled", () => {
    expect(
      parseFileViewStalenessRotationPolicy({
        heartbeat: { fileViewStalenessRotation: { enabled: false } },
      }),
    ).toEqual({ enabled: false });
    expect(
      parseFileViewStalenessRotationPolicy({
        heartbeat: { fileViewStalenessRotation: { enabled: true } },
      }),
    ).toEqual({ enabled: true });
  });
});

describeEmbeddedPostgres("evaluateSessionFileStaleness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceDir: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-file-view-staleness-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      workspaceDir = null;
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "File View Staleness Company",
      issuePrefix: `FV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Staleness Watcher",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertPriorRun(input: {
    companyId: string;
    agentId: string;
    sessionId: string;
    startedAt: Date;
    views: Array<{ relativePath: string; contentHash: string | null; exists: boolean }>;
    cwd?: string | null;
  }) {
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      invocationSource: "test",
      sessionIdAfter: input.sessionId,
      startedAt: input.startedAt,
      contextSnapshot: {
        paperclipWorkspace: { cwd: input.cwd ?? workspaceDir },
        paperclipFileViews: input.views,
      },
    });
  }

  it("rotates when a recorded file was modified after the prior run (stale)", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    const filePath = path.join(workspaceDir, "a.ts");
    await fs.writeFile(filePath, "original contents");
    const sessionId = "sess-stale-1";
    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [{ relativePath: "a.ts", contentHash: sha256("original contents"), exists: true }],
    });
    await fs.writeFile(filePath, "changed contents");

    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: null,
    });

    expect(result.rotate).toBe(true);
    expect(result.staleFiles).toEqual([{ relativePath: "a.ts", status: "stale" }]);
    expect(result.reason).toContain("a.ts (stale)");
    expect(result.reason).toContain("Files changed since the last run in this session");
  });

  it("rotates when a recorded file was deleted after the prior run (missing)", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    const filePath = path.join(workspaceDir, "b.md");
    await fs.writeFile(filePath, "to be deleted");
    const sessionId = "sess-missing-1";
    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [{ relativePath: "b.md", contentHash: sha256("to be deleted"), exists: true }],
    });
    await fs.rm(filePath);

    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: null,
    });

    expect(result.rotate).toBe(true);
    expect(result.staleFiles).toEqual([{ relativePath: "b.md", status: "missing" }]);
    expect(result.reason).toContain("b.md (missing)");
  });

  it("does not rotate when the recorded files are unchanged", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    await fs.writeFile(path.join(workspaceDir, "c.txt"), "stable contents");
    const sessionId = "sess-current-1";
    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [{ relativePath: "c.txt", contentHash: sha256("stable contents"), exists: true }],
    });

    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: null,
    });

    expect(result.rotate).toBe(false);
    expect(result.staleFiles).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it("does not rotate for views without a content hash (unknown)", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    await fs.writeFile(path.join(workspaceDir, "d.txt"), "unknown fingerprint");
    const sessionId = "sess-unknown-1";
    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [{ relativePath: "d.txt", contentHash: null, exists: true }],
    });

    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: null,
    });

    expect(result.rotate).toBe(false);
    expect(result.staleFiles).toEqual([]);
  });

  it("does not rotate when there is no prior run or the prior run has no views", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    const sessionId = "sess-empty-1";

    const noPriorRun = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: workspaceDir,
    });
    expect(noPriorRun.rotate).toBe(false);

    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [],
    });
    const emptyViews = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: workspaceDir,
    });
    expect(emptyViews.rotate).toBe(false);
  });

  it("excludes the current run when picking the most recent prior run", async () => {
    const { companyId, agentId } = await seedAgent();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-view-staleness-"));
    await fs.writeFile(path.join(workspaceDir, "e.ts"), "stable contents");
    const sessionId = "sess-exclude-1";
    await insertPriorRun({
      companyId,
      agentId,
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      views: [{ relativePath: "e.ts", contentHash: sha256("stable contents"), exists: true }],
    });
    const currentRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "test",
      sessionIdAfter: sessionId,
      startedAt: new Date("2025-01-02T00:00:00Z"),
      contextSnapshot: { paperclipWorkspace: { cwd: workspaceDir }, paperclipFileViews: [] },
    });

    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: sessionId,
      currentRunId,
      fallbackWorkspaceCwd: null,
    });

    expect(result.rotate).toBe(false);
    expect(FILE_VIEW_STALENESS_ROTATION_REASON).toBe("file_view_stale");
  });

  it("does not rotate when the resumed session id is empty", async () => {
    const { agentId } = await seedAgent();
    const result = await evaluateSessionFileStaleness(db, {
      agentId,
      resumedSessionId: null,
      currentRunId: randomUUID(),
      fallbackWorkspaceCwd: null,
    });
    expect(result.rotate).toBe(false);
  });
});
