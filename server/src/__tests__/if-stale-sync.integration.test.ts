// server/src/__tests__/if-stale-sync.integration.test.ts
//
// [if-stale-sync] 일반 sync 경로의 stale IF 재평가 검증(임베디드 PG).
//   2026-09-25 run 16dac130: IF 평가(20:13:59)가 상류 이슈 완료(20:17:45)보다 앞서 잘못된
//   false-branch 로 고정 → 다음 날 수동 resume 으로만 복구됐다. resetStaleIfControlNodesForResume
//   을 syncWorkflowRunStateWithOutcome 이 재사용하므로, resume 없이 일반 sync 만으로 재평가와
//   브랜치 정정이 닫히는지 확인한다. 배치는 launch loop 이후(관찰/재평가 분리): stale 를 관찰한
//   sync 는 리셋만 하고, 재평가는 다음 sync, 부활·발사는 그 다음 sync 에서 수렴한다(공식 재작업
//   경로의 한 패스 한 레벨 계약 유지 — workflow-mirror-dag-retry-rework 참조).
//   기존 workflow-control-node-execution.test.ts 의 시딩 방식을 따르되, false-branch 를
//   issue-backed step(fallback-work)로 둬서 시드 시점에 run 이 running(비종결) 상태로 남게
//   하는 것이 차이점이다 — 종결 run 은 terminal-parent 가드가 파생변이를 보류하기 때문.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { useControlNodeFixture } from "./helpers/workflow-control-node-fixture.js";
import { issueService } from "../services/issues.js";
import {
  executeWorkflowRun,
  syncWorkflowRunForIssue,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type ControlNodeResult = { nodeType: string; outcome: string; evaluatedAt: string };

function readControlNodeResult(metadata: Record<string, unknown> | null): ControlNodeResult | null {
  const raw = metadata?.controlNodeResult;
  return raw && typeof raw === "object" ? (raw as ControlNodeResult) : null;
}

describeEmbeddedPostgres("sync-path stale IF re-evaluation (if-stale-sync)", () => {
  let db!: ReturnType<typeof createDb>;
  let artifactRoot = "";
  const fixture = useControlNodeFixture();
  beforeAll(() => {
    db = fixture.db;
    artifactRoot = fixture.artifactRoot;
  });

  async function seedRun(status: "selected" | "empty") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "If Stale Sync Company",
      issuePrefix: `IS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: `If stale sync ${status}`,
      steps: [
        { id: "producer", name: "Producer", agentId, dependencies: [], graphWorkProductRequired: true },
        {
          id: "if-decision",
          name: "Has selected target?",
          type: "if",
          dependencies: ["producer"],
          conditionGroup: {
            combinator: "all",
            conditions: [{
              source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
              dataType: "string",
              operator: "equals",
              rightValue: "selected",
            }],
          },
        },
        {
          id: "selected-work",
          name: "Selected work",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "if-decision", when: "condition_true" }],
        },
        {
          id: "fallback-work",
          name: "Fallback work",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "if-decision", when: "condition_false" }],
        },
      ] as never,
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId: definition.id,
      companyId,
      triggeredBy: "board",
      status: "pending",
      runDate: "2026-09-25",
    });

    await executeWorkflowRun(db, runId);
    const producerRun = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "producer")!);
    await issueService(db).update(producerRun.issueId!, { status: "in_progress" });
    await syncWorkflowRunForIssue(db, producerRun.issueId!);
    const artifactPath = path.join(artifactRoot, `${runId}.json`);
    await writeFile(artifactPath, JSON.stringify({ status }), "utf8");
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerRun.issueId!,
      type: "file",
      provider: "local",
      externalId: artifactPath,
      title: "decision.json",
      status: "active",
      isPrimary: true,
      metadata: { path: artifactPath },
    });
    await issueService(db).update(producerRun.issueId!, { status: "done" });
    const result = await syncWorkflowRunForIssue(db, producerRun.issueId!);
    const stepRuns = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    return { companyId, agentId, runId, artifactPath, result, stepRuns, producerIssueId: producerRun.issueId! };
  }

  it("a) 소스 산물이 평가 시점 이후 갱신되면 일반 sync 만으로 stale IF 를 리셋·재평가해 true-branch 로 정정한다(다음 sync 수렴)", async () => {
    const seeded = await seedRun("empty");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    expect(ifRun.status).toBe("completed");
    expect(readControlNodeResult(ifRun.metadata)).toMatchObject({ outcome: "condition_false" });
    // 비종결 전제: false-branch(fallback-work) 가 발사 대기 중이므로 run 은 running 이다.
    expect(seeded.result?.status).toBe("running");
    expect(seeded.stepRuns.find((row) => row.stepId === "selected-work")!.status).toBe("skipped");
    expect(seeded.stepRuns.find((row) => row.stepId === "fallback-work")!.status).toBe("pending");

    // 레이스 재현: 평가 시점 이후 소스 산물 갱신(파일 교체 + updatedAt 를 평가 시점보다 뒤의
    // 실제 시각으로 — 인위적 미래 시각은 재평가 이후에도 영구 stale 로 순환해 실제 패턴과 다르다).
    const evaluatedAt = readControlNodeResult(ifRun.metadata)!.evaluatedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(seeded.artifactPath, JSON.stringify({ status: "selected" }), "utf8");
    await db.update(issueWorkProducts)
      .set({ updatedAt: new Date() })
      .where(eq(issueWorkProducts.issueId, seeded.producerIssueId));

    // 1차 sync — 관찰: stale verdict 만 폐기한다(pending 리셋, controlNodeResult 삭제).
    //   재평가는 다음 sync 의 launch loop 가 수행한다(한 패스 한 레벨 — 공식 재작업 경로의
    //   resume 레벨 계약과 동일 속도. launch 안에서 재평가까지 끝내면 기존 재작업 계약과 충돌한다).
    const first = await syncWorkflowRunForIssue(db, seeded.producerIssueId);
    expect(first?.status).not.toBe("failed");

    const afterFirst = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId));
    const afterFirstIf = afterFirst.find((row) => row.stepId === "if-decision")!;
    expect(afterFirstIf.status).toBe("pending");
    expect(readControlNodeResult(afterFirstIf.metadata)).toBeNull(); // verdict 폐기 확인

    // 2차 sync — 재평가: 갱신된 소스 기준 condition_true 로 verdict 가 새로 쓰인다.
    const second = await syncWorkflowRunState(db, seeded.runId);
    expect(second.status).not.toBe("failed");
    const afterSecond = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId));
    const afterSecondIf = afterSecond.find((row) => row.stepId === "if-decision")!;
    expect(afterSecondIf.status).toBe("completed");
    const reevaluated = readControlNodeResult(afterSecondIf.metadata)!;
    expect(reevaluated).toMatchObject({ outcome: "condition_true" });
    expect(Date.parse(reevaluated.evaluatedAt)).toBeGreaterThan(Date.parse(evaluatedAt));
    // 재평가 시점에는 아직 skip 부활이 일어나지 않는다(한 패스 한 레벨).
    expect(afterSecond.find((row) => row.stepId === "selected-work")!.status).toBe("skipped");

    // 3차 sync — 부활·발사: true-branch 가 살아나 마무리된다.
    const third = await syncWorkflowRunState(db, seeded.runId);
    expect(third.status).not.toBe("failed");
    const afterThird = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId));
    const selected = afterThird.find((row) => row.stepId === "selected-work")!;
    expect(selected.status).toBe("pending");
    expect(selected.issueId).toBeTruthy();
    // 재평가된 verdict 는 후속 sync 에서 재리셋 없이 안정적으로 유지된다.
    expect(readControlNodeResult(afterThird.find((row) => row.stepId === "if-decision")!.metadata))
      .toMatchObject({ outcome: "condition_true" });
  });

  it("b) 소스 산물이 평가 시점보다 이전(신선)이면 리셋 없이 기존 verdict 를 유지한다", async () => {
    const seeded = await seedRun("empty");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    const before = readControlNodeResult(ifRun.metadata)!;
    expect(before).toMatchObject({ outcome: "condition_false" });
    expect(seeded.result?.status).toBe("running");

    // 신선 케이스 고정: 평가 시점보다 확실히 이전으로 updatedAt 를 맞춘 뒤 일반 sync 재실행.
    await db.update(issueWorkProducts)
      .set({ updatedAt: new Date(Date.parse(before.evaluatedAt) - 60_000) })
      .where(eq(issueWorkProducts.issueId, seeded.producerIssueId));

    const result = await syncWorkflowRunState(db, seeded.runId);
    expect(result.status).not.toBe("failed");

    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, ifRun.id)).then((rows) => rows[0]!);
    expect(reloaded.status).toBe("completed");
    const after = readControlNodeResult(reloaded.metadata)!;
    expect(after.outcome).toBe("condition_false");
    expect(after.evaluatedAt).toBe(before.evaluatedAt); // 재평가 없음
    const reloadedAll = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId));
    expect(reloadedAll.find((row) => row.stepId === "selected-work")!.status).toBe("skipped");
    expect(reloadedAll.find((row) => row.stepId === "fallback-work")!.status).toBe("pending");
  });
});
