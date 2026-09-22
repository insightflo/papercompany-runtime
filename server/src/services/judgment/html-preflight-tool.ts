import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, toolDefinitions } from "@paperclipai/db";

export const HTML_PREFLIGHT_TOOL_NAME = "html-preflight";

export const HTML_PREFLIGHT_TOOL_DESCRIPTION =
  "LLM 없이 HTML 문서의 빈/거의 빈 텍스트, 명백한 구조 파손 신호, 크기 통계만 conservatively 점검한다. HTML validator가 아니며 권고용 구조 결과만 반환한다.";

export const HTML_PREFLIGHT_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    document: {
      type: "string",
      description: "인라인 HTML 문서. 외부 리소스를 가져오지 않고 로컬 파싱만 한다.",
    },
    documentPath: {
      type: "string",
      description: "워크플로우 스텝 문맥에서만 허용되는 조상 스텝 workProduct 파일 경로.",
    },
  },
  anyOf: [
    { required: ["document"] },
    { required: ["documentPath"] },
  ],
  additionalProperties: false,
};

async function ensureHtmlPreflightTool(db: Db, companyId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: toolDefinitions.id })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, companyId),
      eq(toolDefinitions.name, HTML_PREFLIGHT_TOOL_NAME),
    ))
    .limit(1);
  if (existing) return false;

  const inserted = await db
    .insert(toolDefinitions)
    .values({
      companyId,
      name: HTML_PREFLIGHT_TOOL_NAME,
      description: HTML_PREFLIGHT_TOOL_DESCRIPTION,
      inputSchema: HTML_PREFLIGHT_TOOL_INPUT_SCHEMA,
      adapterType: "builtin",
      adapterConfig: { kind: "html-preflight" },
      enabled: true,
    })
    .onConflictDoNothing({
      target: [toolDefinitions.companyId, toolDefinitions.name],
    })
    .returning({ id: toolDefinitions.id });
  return inserted.length > 0;
}

export async function seedHtmlPreflightTool(
  db: Db,
  options: { companyId?: string } = {},
): Promise<{ companies: number; toolsSeeded: number }> {
  const rows = options.companyId
    ? [{ id: options.companyId }]
    : await db.select({ id: companies.id }).from(companies);
  let toolsSeeded = 0;
  for (const row of rows) {
    if (await ensureHtmlPreflightTool(db, row.id)) toolsSeeded += 1;
  }
  return { companies: rows.length, toolsSeeded };
}
