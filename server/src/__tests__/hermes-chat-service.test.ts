import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { agents, companies, createDb, hermesChatMessages, hermesChatSessions } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hermesChatService, responseTextFromRun } from "../services/hermes-chat.js";

describe("Hermes chat response extraction", () => {
  it("uses the raw run result instead of the 500-character run summary", () => {
    const longAnswer = [
      "현재 상태부터 다시 정리하면:",
      "",
      "1. 현재 상태",
      "- 미션은 completed 입니다.",
      "- 이슈 10개는 모두 done 입니다.",
      "- 워크플로우 런은 completed 입니다.",
      "",
      "2. 왜 이런 상태냐",
      "초기 QA인 RES-974가 한 번 REQUEST_CHANGES였지만 이후 수정과 재검증이 완료되었습니다.",
      "이 문장은 500자 뒤에도 보존되어야 합니다.",
      "x".repeat(650),
      "끝.",
    ].join("\n");

    const extracted = responseTextFromRun({
      status: "succeeded",
      resultJson: {
        result: longAnswer,
      },
      error: null,
    });

    expect(extracted).toBe(longAnswer);
    expect(extracted).toContain("이 문장은 500자 뒤에도 보존되어야 합니다.");
    expect(extracted.endsWith("끝.")).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Hermes chat service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Hermes chat operations agent bootstrap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hermes-chat-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(hermesChatMessages);
    await db.delete(hermesChatSessions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not create a Hermes Ops agent while creating a chat session", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plain Company",
      issuePrefix: `HC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = hermesChatService(db);
    const session = await service.createSession(companyId, {});

    expect(session.agentId).toBeNull();
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("creates a generic Hermes Ops agent only when explicitly ensured", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plain Company",
      issuePrefix: `HC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = hermesChatService(db);
    const ensured = await service.ensureOperationsAgent(companyId);

    expect(ensured.autoProvisionedNow).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, ensured.id)).limit(1);
    expect(agent).toMatchObject({
      companyId,
      name: "Hermes Operations Manager",
      role: "pm",
      title: "Hermes Operations Manager",
      adapterType: "hermes_local",
      status: "idle",
    });
    expect(agent?.metadata).toEqual(expect.objectContaining({
      purpose: "hermes-operations-management",
      autoProvisioned: true,
    }));
    expect(agent?.metadata).not.toEqual(expect.objectContaining({
      purpose: "research-company-hermes-management",
    }));
    expect(agent?.runtimeConfig).toEqual(expect.objectContaining({
      domain: "operations",
      operatingMode: "chief_of_staff_liaison",
    }));
  });
});
