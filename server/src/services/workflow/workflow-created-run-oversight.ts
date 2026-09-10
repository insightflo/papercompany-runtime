import { eq } from "drizzle-orm";
import { workflowDefinitions, type Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../../errors.js";
import { missionService } from "../missions.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import type { WorkflowRun } from "./types.js";

/**
 * [파일 목적] Task5a2a: engine.trigger 의 post-create mission oversight 블록을 1:1 추출.
 *   createWorkflowRun 직후 호출되며, missionId 가 없으면 즉시 반환한다. snapshot source 는
 *   캡처 provenance.workflowName + execution.steps 로 oversight 를 구성해 정의가 나중에
 *   바뀌어도 post-create oversight 가 캡처 그래프와 일치하게 한다. legacy_current 만
 *   workflowDefinitions 직접 SELECT 로 현재 이름을 쓴다(기존 동작 정확 유지).
 * [계약] missionService(db).getById/ensureMainExecutorOversightIssue 실제 의미론을 우회하지
 *   않는다. loader->dag 런타임 cycle 을 만들지 않도록 이 모듈은 projection 모듈을 import 하지
 *   않고, snapshot 이름은 로더 계약(null provenance 불가)을 강제하는 동일한 null guard 로 읽는다.
 */
export async function ensureCreatedRunOversight(db: Db, run: WorkflowRun): Promise<void> {
  if (!run.missionId) return;
  const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
  let workflowName: string;
  if (execution.source === "snapshot") {
    const provenance = execution.provenance;
    if (!provenance) {
      throw unprocessable("historical_definition_unproven", { reason: "missing_provenance" });
    }
    workflowName = provenance.workflowName;
  } else {
    const [definition] = await db
      .select({ name: workflowDefinitions.name })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, run.workflowId))
      .limit(1);
    if (!definition) throw notFound(`Workflow definition not found: ${run.workflowId}`);
    workflowName = definition.name;
  }
  const mission = await missionService(db).getById(run.missionId);
  if (mission) {
    await missionService(db).ensureMainExecutorOversightIssue(mission, workflowName, {
      sourceRunId: run.id,
      workflowStepIds: execution.steps.map((step) => step.id),
    });
  }
}
