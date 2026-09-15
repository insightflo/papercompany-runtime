import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";

// Isolated DB only: reconstruct the pre-T1 schema, seed a legacy row, then apply the
// generated delta through PostgreSQL. Never target runtime connection configuration.
describeQualityDb("quality migration preserves pre-existing rows", () => {
  let owned: Awaited<ReturnType<typeof createQualityTestDb>>;
  beforeAll(async () => { owned = await createQualityTestDb(); }, 120_000);
  afterAll(async () => { await owned?.close(); });
  it("adds nullable contracts without fabricating approvals, activations, or evidence", async () => {
    const { db } = owned;
    await db.execute(sql`drop table quality_consumer_bindings, quality_occurrences, quality_actions, quality_action_groups, quality_policy_usage, quality_policy_versions cascade`);
    const columns: Record<string, string[]> = {
      operator_decisions: ["quality_action_id", "quality_binding"],
      quality_evidence_refs: ["quality_action_id", "quality_contract"],
      evaluator_versions: ["quality_action_id", "quality_contract"],
      evaluator_candidate_runs: ["quality_action_id", "quality_contract"],
      agent_wakeup_requests: ["quality_acceptance"],
      mission_plan_qa_verdicts: ["quality_contract"], issues: ["quality_plan_qa_binding"],
    };
    for (const [table, names] of Object.entries(columns)) {
      for (const name of names) await db.execute(sql.raw(`alter table "${table}" drop column "${name}" cascade`));
    }
    const indexes = ["heartbeat_runs", "quality_review_items", "mission_plan_templates", "evaluator_versions", "quality_evidence_refs"];
    for (const table of indexes) await db.execute(sql.raw(`drop index "${table}_quality_company_id_uq"`));
    await db.execute(sql`drop index agent_wakeup_requests_quality_action_wake_uq`);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.execute(sql`insert into companies (id,name,issue_prefix) values (${companyId},'legacy','QT')`);
    await db.execute(sql`insert into issues (id,company_id,title,status) values (${issueId},${companyId},'legacy title','done')`);
    const before = await db.execute(sql`select id, company_id, title, status, created_at from issues where id=${issueId}`);
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0106_quick_triathlon.sql", import.meta.url), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    });
    const after = await db.execute(sql`select id, company_id, title, status, created_at from issues where id=${issueId}`);
    expect(Array.from(after)).toEqual(Array.from(before));
    const [row] = await db.execute(sql`select quality_plan_qa_binding from issues where id=${issueId}`);
    expect(row!.quality_plan_qa_binding).toBeNull();
    for (const table of ["quality_policy_versions", "quality_actions", "quality_consumer_bindings", "quality_occurrences"]) {
      const [count] = await db.execute(sql.raw(`select count(*)::int as count from "${table}"`));
      expect(count!.count).toBe(0);
    }
  });
});
