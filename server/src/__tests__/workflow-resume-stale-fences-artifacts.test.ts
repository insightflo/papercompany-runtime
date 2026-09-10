import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  countFenceWorkProducts,
  seedFenceGraph,
  seedFenceIssue,
  seedFenceStepRun,
  setFenceRunMetadata,
  startFenceFixture,
  type FenceFixture,
} from "./helpers/workflow-resume-stale-fences-fixture.js";
import { assertIssueResumeScopeIdentity } from "../services/workflow/resume-scope-fence.js";
import { workProductService } from "../services/work-products.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import { HttpError } from "../errors.js";

/**
 * [목적] Task6c stale-generation result fence (실DB) — contract D(agent artifact submission).
 *   resume-linked issue 의 agent 산출물 등록은 새 approval 절차 없이 세대 정체 검증만 수행한다:
 *   issue 의 active step run 이 부모 run 의 현재 resume stamp 과 어긋나면 409 stale_generation.
 *   ordinary issue 는 검증이 즉시 통과 — 기존 동작 byte-identical. mock DB/엔진 없음.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let fixture: FenceFixture;
let db: Db;

beforeAll(async () => {
  fixture = await startFenceFixture("resume-stale-fences-artifact-");
  if (!fixture.supported) throw new Error(fixture.reason);
  db = fixture.db;
}, 60_000);
afterAll(async () => {
  if (fixture?.supported) await fixture.cleanup();
});

function artifactInput(title: string) {
  return {
    type: "document",
    provider: "custom",
    title,
    status: "active",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    metadata: { path: `/tmp/stale-fences/${title}.md` },
  } as const;
}

describeEmbeddedPostgres("task6c stale fences — agent artifact submission (contract D)", () => {
  it("rejects an artifact submission for a resume-linked issue whose step lags the run's resume epoch with 409 stale_generation", async () => {
    const graph = await seedFenceGraph(db, "FENCE-D1", { runMetadata: { resumeRequestId: randomUUID() } });
    const staleStamp = randomUUID();
    const currentStamp = randomUUID();
    const issueId = await seedFenceIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await seedFenceStepRun(db, {
      runId: graph.runId,
      values: {
        status: "running",
        issueId,
        executionGeneration: 1,
        metadata: { resumeRequestId: staleStamp },
      },
    });
    await setFenceRunMetadata(db, graph.runId, { resumeRequestId: currentStamp });

    expect(await assertIssueResumeScopeIdentity(db, { companyId: graph.companyId, issueId })).toBe(false);
    const svc = workProductService(db);
    const error = await captureHttpError(svc.createForIssue(issueId, graph.companyId, artifactInput("stale-artifact")));
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).message).toBe("stale_generation");
    expect(await countFenceWorkProducts(fixture.sql, issueId)).toBe(0);
  });

  it("accepts artifact submissions for identity-matching resume issues and for ordinary issues", async () => {
    const stamp = randomUUID();
    const resumeGraph = await seedFenceGraph(db, "FENCE-D2", { runMetadata: { resumeRequestId: stamp } });
    const resumeIssue = await seedFenceIssue(db, { companyId: resumeGraph.companyId, missionId: resumeGraph.missionId });
    await seedFenceStepRun(db, {
      runId: resumeGraph.runId,
      values: {
        status: "running",
        issueId: resumeIssue,
        executionGeneration: 4,
        metadata: { resumeRequestId: stamp },
      },
    });
    expect(await assertIssueResumeScopeIdentity(db, { companyId: resumeGraph.companyId, issueId: resumeIssue })).toBe(true);

    const svc = workProductService(db);
    const created = await svc.createForIssue(resumeIssue, resumeGraph.companyId, artifactInput("fresh-artifact"));
    expect(created).not.toBeNull();

    // ordinary regression: stamp 없는 run 의 issue 등록은 기존과 동일하게 수용된다.
    const ordinaryGraph = await seedFenceGraph(db, "FENCE-D2-ORD");
    const ordinaryIssue = await seedFenceIssue(db, { companyId: ordinaryGraph.companyId, missionId: ordinaryGraph.missionId });
    await seedFenceStepRun(db, { runId: ordinaryGraph.runId, values: { status: "running", issueId: ordinaryIssue } });
    const ordinaryCreated = await svc.createForIssue(ordinaryIssue, ordinaryGraph.companyId, artifactInput("ordinary-artifact"));
    expect(ordinaryCreated).not.toBeNull();
  });
});
