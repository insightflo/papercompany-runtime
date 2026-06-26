import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { activityLog, agents, companies, createDb, hermesChatMessages, hermesChatSessions } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { hermesChatRoutes } from "../routes/hermes-chat.js";

const mockHermesEnvironmentTest = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/index.js")>();
  return {
    ...actual,
    findServerAdapter: (type: string) => {
      if (type === "hermes_local") {
        return {
          ...actual.findServerAdapter(type),
          testEnvironment: mockHermesEnvironmentTest,
        };
      }
      return actual.findServerAdapter(type);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Hermes chat route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createApp(db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", hermesChatRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("Hermes chat routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hermes-chat-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    mockHermesEnvironmentTest.mockResolvedValue({
      adapterType: "hermes_local",
      status: "fail",
      checks: [{
        code: "hermes_cli_not_found",
        level: "error",
        message: "Hermes CLI \"hermes\" not found in PATH",
        hint: "Install Hermes Agent: pip install hermes-agent",
      }],
      testedAt: "2026-06-26T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(hermesChatMessages);
    await db.delete(hermesChatSessions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plain Company",
      issuePrefix: `HC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("reports Hermes environment status before asking to create an operations agent", async () => {
    const companyId = await insertCompany();

    const res = await request(createApp(db))
      .get(`/api/companies/${companyId}/hermes-chat/operations-agent`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      agent: null,
      environment: {
        status: "fail",
        checks: [expect.objectContaining({ code: "hermes_cli_not_found" })],
      },
    });
    expect(mockHermesEnvironmentTest).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      adapterType: "hermes_local",
      config: {},
    }));
  });

  it("does not create a Hermes Ops agent when the Hermes CLI is unavailable", async () => {
    const companyId = await insertCompany();

    const res = await request(createApp(db))
      .post(`/api/companies/${companyId}/hermes-chat/operations-agent`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Hermes local environment is not ready",
      environment: {
        status: "fail",
        checks: [expect.objectContaining({ code: "hermes_cli_not_found" })],
      },
    });
    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(0);
  });
});
