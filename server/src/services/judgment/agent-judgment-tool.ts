import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, judgmentDefinitions, toolDefinitions } from "@paperclipai/db";
import type { JudgmentDefinitionSnapshot } from "@paperclipai/shared";

export const AGENT_JUDGMENT_TOOL_NAME = "judgment";
export const AGENT_JUDGMENT_DEFINITION_NAME = "agent-judgment";
export const AGENT_JUDGMENT_MODEL_ID = "jev-1.13.0";

export const AGENT_JUDGMENT_TOOL_DESCRIPTION =
  "출력물 생성 없이 판단만 필요한 순간(분기 결정, 후보 탈락, 이 서브태스크를 실행할 가치가 있는지, 범위 축소, 통과/차단)에 LLM 대신 이 도구를 먼저 호출해 판단값(선택+확률+신뢰도)을 얻는다. questions는 {이름: {type:'choice'|'noul'|'score', instructions, criteria}} 형태로 여러 개를 한 번에 묶는다. 신뢰도가 낮으면(권고: 0.5 미만) 그 분기는 건너뛰거나 사람/상위 에이전트에 맡긴다.";

export const AGENT_JUDGMENT_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    state: {
      description: "판단에 필요한 JSON 상태. 직렬화 결과는 120,000자를 넘을 수 없다.",
      oneOf: [
        { type: "string" },
        { type: "object", additionalProperties: true },
        { type: "array", items: { type: "string" } },
      ],
    },
    questions: {
      type: "object",
      minProperties: 1,
      description: "질문 이름을 키로 하는 choice, noul, score 질문 묶음.",
      additionalProperties: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["choice", "noul", "score"] },
          instructions: { type: "string", minLength: 1 },
          criteria: {
            oneOf: [
              { type: "string" },
              { type: "object", additionalProperties: { type: ["string", "null"] } },
              { type: "array", items: { type: ["string", "null"] } },
            ],
          },
        },
        required: ["type", "instructions"],
        additionalProperties: false,
      },
    },
  },
  required: ["state", "questions"],
  additionalProperties: false,
};

const AGENT_JUDGMENT_DEFINITION_VERSION = 1;

export function buildAgentJudgmentDefinition(): JudgmentDefinitionSnapshot {
  return {
    description: "에이전트의 출력 생성 전 분기 판단을 관측 전용으로 평가한다.",
    purpose: "agent-branch-pruning",
    originClass: "internal",
    stateAssembly: {
      kind: "inline-ref",
      notes: "호출자가 제공한 state를 반출 검사 후 판단 공급자에 전달한다.",
    },
    questions: [
      {
        name: "placeholder",
        type: "choice",
        instructions: "호출자가 제공한 질문에 따라 분기 판단을 수행한다.",
        criteria: {
          proceed: "진행할 가치가 있음",
          skip: "건너뛰거나 상위 판단으로 넘김",
        },
      },
    ],
    policy: {
      notes: "판단 결과는 관측 전용 권고이며 실행 권한이나 완료 판정이 아니다.",
      thresholds: { low_confidence: 0.5 },
    },
  };
}

async function ensureAgentJudgmentTool(db: Db, companyId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: toolDefinitions.id })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, companyId),
      eq(toolDefinitions.name, AGENT_JUDGMENT_TOOL_NAME),
    ))
    .limit(1);
  if (existing) return false;

  const inserted = await db
    .insert(toolDefinitions)
    .values({
      companyId,
      name: AGENT_JUDGMENT_TOOL_NAME,
      description: AGENT_JUDGMENT_TOOL_DESCRIPTION,
      inputSchema: AGENT_JUDGMENT_TOOL_INPUT_SCHEMA,
      adapterType: "builtin",
      adapterConfig: { kind: "judgment" },
      enabled: true,
    })
    .onConflictDoNothing({
      target: [toolDefinitions.companyId, toolDefinitions.name],
    })
    .returning({ id: toolDefinitions.id });
  return inserted.length > 0;
}

async function ensureAgentJudgmentDefinition(db: Db, companyId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: judgmentDefinitions.id })
    .from(judgmentDefinitions)
    .where(and(
      eq(judgmentDefinitions.companyId, companyId),
      eq(judgmentDefinitions.name, AGENT_JUDGMENT_DEFINITION_NAME),
      eq(judgmentDefinitions.isActive, true),
    ))
    .limit(1);
  if (existing) return false;

  const inserted = await db
    .insert(judgmentDefinitions)
    .values({
      companyId,
      name: AGENT_JUDGMENT_DEFINITION_NAME,
      version: AGENT_JUDGMENT_DEFINITION_VERSION,
      isActive: true,
      providerId: "typesafe",
      modelId: AGENT_JUDGMENT_MODEL_ID,
      definition: buildAgentJudgmentDefinition(),
    })
    .onConflictDoNothing({
      target: [
        judgmentDefinitions.companyId,
        judgmentDefinitions.name,
        judgmentDefinitions.version,
      ],
    })
    .returning({ id: judgmentDefinitions.id });
  return inserted.length > 0;
}

export async function seedAgentJudgmentTool(
  db: Db,
  options: { companyId?: string } = {},
): Promise<{ companies: number; toolsSeeded: number; definitionsSeeded: number }> {
  const rows = options.companyId
    ? [{ id: options.companyId }]
    : await db.select({ id: companies.id }).from(companies);
  let toolsSeeded = 0;
  let definitionsSeeded = 0;
  for (const row of rows) {
    if (await ensureAgentJudgmentTool(db, row.id)) toolsSeeded += 1;
    if (await ensureAgentJudgmentDefinition(db, row.id)) definitionsSeeded += 1;
  }
  return { companies: rows.length, toolsSeeded, definitionsSeeded };
}
