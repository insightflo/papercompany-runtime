import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companySecretVersions,
  companySecrets,
  createDb,
  workflowDefinitions,
  workflowWebhookDeliveries,
} from "@paperclipai/db";
import { freshCompany } from "./helpers/bounded-reads-test-utils.js";
import { secretService } from "../services/secrets.js";
import {
  WebhookQuotaExceededError,
  admitWebhookDelivery,
  resolveWorkflowWebhookSecret,
} from "../services/workflow/workflow-webhook.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres webhook admission tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const QUOTA = { max: 60, windowMs: 3_600_000 };

describeEmbeddedPostgres("admitWebhookDelivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-admission-");
    db = createDb(tempDb.connectionString);
    companyId = await freshCompany(db);
    workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "wf" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Each quota-sensitive test runs against its own workflow so the 60-slot
  // window of one test never leaks into the next.
  async function newWorkflow(): Promise<string> {
    const id = randomUUID();
    await db.insert(workflowDefinitions).values({ id, companyId, name: `wf-${id.slice(0, 6)}` });
    return id;
  }

  it("inserts a delivery receipt (replay=false)", async () => {
    const result = await admitWebhookDelivery(db, {
      companyId,
      workflowId,
      idempotencyKey: "key-1",
      quota: QUOTA,
    });
    expect(result.replay).toBe(false);
    expect(result.delivery.runId).toBeNull();
    const rows = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(and(eq(workflowWebhookDeliveries.workflowId, workflowId), eq(workflowWebhookDeliveries.idempotencyKey, "key-1")));
    expect(rows).toHaveLength(1);
  });

  it("returns the existing receipt on replay (replay=true, no second row)", async () => {
    const first = await admitWebhookDelivery(db, {
      companyId,
      workflowId,
      idempotencyKey: "key-2",
      quota: QUOTA,
    });
    const second = await admitWebhookDelivery(db, {
      companyId,
      workflowId,
      idempotencyKey: "key-2",
      quota: QUOTA,
    });
    expect(second.replay).toBe(true);
    expect(second.delivery.id).toBe(first.delivery.id);
    const rows = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "key-2"));
    expect(rows).toHaveLength(1);
  });

  it("throws a 429-typed error at the 61st delivery inside the window", async () => {
    const quotaWorkflowId = await newWorkflow();
    for (let i = 0; i < 60; i++) {
      await admitWebhookDelivery(db, {
        companyId,
        workflowId: quotaWorkflowId,
        idempotencyKey: `quota-key-${i}`,
        quota: QUOTA,
      });
    }
    await expect(
      admitWebhookDelivery(db, {
        companyId,
        workflowId: quotaWorkflowId,
        idempotencyKey: "quota-key-over",
        quota: QUOTA,
      }),
    ).rejects.toBeInstanceOf(WebhookQuotaExceededError);
  });

  it("does not count deliveries outside the quota window", async () => {
    const oldWorkflowId = await newWorkflow();
    const old = new Date(Date.now() - 2 * QUOTA.windowMs);
    for (let i = 0; i < 60; i++) {
      await db.insert(workflowWebhookDeliveries).values({
        companyId,
        workflowId: oldWorkflowId,
        idempotencyKey: `old-key-${i}`,
        receivedAt: old,
      });
    }
    const result = await admitWebhookDelivery(db, {
      companyId,
      workflowId: oldWorkflowId,
      idempotencyKey: "fresh-after-old",
      quota: QUOTA,
    });
    expect(result.replay).toBe(false);
  });

  it("concurrent admits with the same key produce exactly one delivery row", async () => {
    const concurrentWorkflowId = await newWorkflow();
    const [a, b] = await Promise.all([
      admitWebhookDelivery(db, {
        companyId,
        workflowId: concurrentWorkflowId,
        idempotencyKey: "concurrent-key",
        quota: QUOTA,
      }),
      admitWebhookDelivery(db, {
        companyId,
        workflowId: concurrentWorkflowId,
        idempotencyKey: "concurrent-key",
        quota: QUOTA,
      }),
    ]);
    const rows = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "concurrent-key"));
    expect(rows).toHaveLength(1);
    const replays = [a, b].filter((r) => r.replay);
    expect(replays).toHaveLength(1);
  });
});

describeEmbeddedPostgres("resolveWorkflowWebhookSecret", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;
  let secretRef!: string;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-secret-");
    db = createDb(tempDb.connectionString);
    companyId = await freshCompany(db);
    workflowId = randomUUID();
    secretRef = `workflow-webhook:${workflowId}`;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns null when no secret exists for the ref", async () => {
    const resolved = await resolveWorkflowWebhookSecret(db, {
      companyId,
      secretRef,
    });
    expect(resolved).toBeNull();
  });

  it("resolves the current secret after creation", async () => {
    const secrets = secretService(db);
    await secrets.create(companyId, {
      name: secretRef,
      provider: "local_encrypted",
      value: "secret-v1",
    });
    const resolved = await resolveWorkflowWebhookSecret(db, { companyId, secretRef });
    expect(resolved?.current).toBe("secret-v1");
    expect(resolved?.previous).toBeNull();
  });

  it("resolves current + previous inside the rotation window and drops expired previous", async () => {
    const secrets = secretService(db);
    await secrets.rotate((await secrets.getByName(companyId, secretRef))!.id, { value: "secret-v2" });
    const resolved = await resolveWorkflowWebhookSecret(db, { companyId, secretRef });
    expect(resolved?.current).toBe("secret-v2");
    expect(resolved?.previous?.value).toBe("secret-v1");

    // Force the previous version outside the 24h rotation window.
    const [secretRow] = await db.select().from(companySecrets).where(eq(companySecrets.name, secretRef));
    await db
      .update(companySecretVersions)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(and(eq(companySecretVersions.secretId, secretRow.id), eq(companySecretVersions.version, 1)));
    const expired = await resolveWorkflowWebhookSecret(db, { companyId, secretRef });
    expect(expired?.current).toBe("secret-v2");
    expect(expired?.previous).toBeNull();
  });
});
