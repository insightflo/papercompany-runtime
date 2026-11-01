import { spawn } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { cardHumanSummaries } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * [휴먼카드 초보자 해석본 — 표시 전용 서비스]
 *
 * 계약(변경 금지):
 * - 카드 원본 테이블과 생성·승인·복구 파이프라인은 건드리지 않는다.
 * - 이 서비스는 (company, cardKind, cardId)마다 해석 1행을 만들고 갱신할 뿐이다.
 * - 해석 실행은 비동기 fire-and-forget: 실패·지연이 카드 조회·처리를 막지 않는다.
 *   조회 계층은 행이 없거나 failed면 원문만 보여준다(원문 폴백).
 *
 * 해석 실행 형태: 업무 에이전트(하트비트·작업공간 결합)와 다른, CLI 일회 호출.
 * 현재 지원 어댑터: pi_local (pi -p). 다른 어댑터는 Stage 3에서 확장한다.
 * 재시도 없음 1회성 — 표시 전용이므로 실패는 원문 폴백으로 충분하다.
 */

const SUMMARY_JSON_SCHEMA = z.object({
  oneLine: z.string().min(1),
  whatHappening: z.string().min(1),
  decisionNeeded: z.string().min(1),
  options: z.array(z.object({ label: z.string().min(1), meaning: z.string().min(1) })).default([]),
  cautions: z.array(z.string().min(1)).default([]),
});

export type CardSummaryJson = z.infer<typeof SUMMARY_JSON_SCHEMA>;
export type CardSummaryRow = typeof cardHumanSummaries.$inferSelect;

export type CardKind = "approval" | "owner_recovery" | "operator_decision";

/** 해석에 넘길 카드 뷰 — 조회 계층이 원본 payload에서 시각적으로 안전한 필드만 뽑아 만든다. */
export type CardSourceView = {
  kind: CardKind;
  title?: string;
  type?: string;
  status?: string;
  payload?: Record<string, unknown>;
  bodyText?: string;
};

const DEFAULT_ADAPTER = (process.env.CARD_SUMMARY_DEFAULT_ADAPTER ?? "pi_local").trim() || "pi_local";
const DEFAULT_MODEL = (process.env.CARD_SUMMARY_MODEL ?? "").trim();
/** 해석 CLI 시간제한(ms). 기본은 제한 없음(0) — 화면 실행 해석이 긴 카드에서 인위적으로 실패하지 않게 한다(2026-11-01 사용자 지시). 필요 시 CARD_SUMMARY_TIMEOUT_MS로 제한 복원. */
const CLI_TIMEOUT_MS = Number(process.env.CARD_SUMMARY_TIMEOUT_MS ?? 0);
const MAX_SOURCE_JSON_CHARS = 12_000;

/** vitest 실행 중에는 배경 보장(행 생성·CLI 스폰)을 하지 않는다 — 테스트 정리 경합·자식 프로세스 누수 방지.
 *  표시 전용 기능이라 기능 손실 없음(원문 폴백). 배경 동작은 목 테스트+배포 후 라이브 검증이 담당한다. */
const BACKGROUND_ENABLED = process.env.VITEST === undefined;

function buildPrompt(view: CardSourceView): string {
  const source = JSON.stringify(
    {
      kind: view.kind,
      title: view.title ?? null,
      type: view.type ?? null,
      status: view.status ?? null,
      payload: view.payload ?? null,
      bodyText: view.bodyText ? view.bodyText.slice(0, MAX_SOURCE_JSON_CHARS) : null,
    },
    null,
    1,
  );
  return [
    "당신은 Papercompany 보드의 '휴먼카드 해석 도우미'입니다.",
    "운영자(초보자)에게 보여줄 카드 해석본을 만듭니다. 아래 카드 원본(JSON)만 근거로 삼고, 원본에 없는 사실을 만들지 마세요.",
    "",
    "## 카드 원본",
    source,
    "",
    "## 통역 계약 (im-human — 초보자 통역 모드)",
    "에이전트식 기술 보고를 사용자가 바로 판단할 수 있는 한국어로 통역합니다. 압축 요약이 아니라 사람 기준의 통역입니다.",
    "- 원문에 있는 사실만 말합니다. 원문·증거에 없는 과정이나 결과를 만들지 않습니다.",
    "- 확인된 것과 확인되지 않은 것을 나눕니다. 미확인은 '확인할 수 없습니다'라고 명시합니다.",
    "- 결론부터 말하고 과장 없이 사실 그대로 전달합니다. 성공/실패/진행 중/확인 불가를 명확히 구분합니다.",
    "- 쉬운 존댓말 한국어로 씁니다.",
    "- 내부 ID(UUID, 실행 번호, 이슈 번호, 해시 등)는 사람이 알 수 있는 이름표 뒤에 원문을 괄호로 붙입니다. 예: '새 실행을 시작했습니다(내부 실행 번호 f8e9e55d)'. ID만 나열하는 문장은 쓰지 않습니다.",
    "- 전문 용어는 처음 나올 때 짧은 풀이와 일상 비유를 붙입니다. 예: 'run ID: 이번 실행을 찾기 위한 내부 번호. 택배 송장번호 같은 역할.'",
    "",
    "## 출력 형식",
    "- 반드시 아래 JSON 스키마에 맞는 JSON 하나만 출력하세요. 코드블록이나 설명문 금지.",
    '- 스키마: {"oneLine": string, "whatHappening": string, "decisionNeeded": string, "options": [{"label": string, "meaning": string}], "cautions": string[]}',
    "- oneLine: 이 카드가 무슨 뜻인지 한 줄 결론(결론 먼저).",
    "- whatHappening: 무슨 일이 벌어지고 있는지 2~4문장. 확인된 사실만 쓰고, 안 되는 건 '확인할 수 없습니다'로 명시합니다.",
    "- decisionNeeded: 운영자가 지금 결정/행동해야 할 것. 원문에 근거가 없으면 '지금 내리실 결정은 없습니다'처럼 명확히 씁니다.",
    "- options: 카드가 제시하는 선택지(승인/거절 등) 각각이 무엇을 의미하는지. 선택지가 없으면 빈 배열.",
    "- cautions: 오해하기 쉬운 점(예: '승인만으로 실행되지 않음') 최소 필수만. 없으면 빈 배열.",
    "- 원본이 승인 절차·복구 요청의 '내용'일 뿐, 실제 실행 권한은 이 해석에 없습니다.",
  ].join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model output contains no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function runCliOnce(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    const child = spawn("pi", args, { cwd: process.env.TMPDIR ?? "/tmp", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = CLI_TIMEOUT_MS > 0
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`card summary CLI timeout after ${CLI_TIMEOUT_MS}ms`));
        }, CLI_TIMEOUT_MS)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 && stdout.trim().length > 0) resolve(stdout);
      else reject(new Error(`card summary CLI exit=${code} stderr=${stderr.slice(0, 300)}`));
    });
  });
}

export function cardSummaryService(db: Db) {
  /** 프로세스 내 중복 실행 방지(행 단위). 재시작 후 pending 행은 다음 조회 시 재기동된다. */
  const inFlight = new Map<string, Promise<void>>();

  function key(companyId: string, cardKind: string, cardId: string): string {
    return `${companyId}:${cardKind}:${cardId}`;
  }

  async function getRow(companyId: string, cardKind: CardKind, cardId: string): Promise<CardSummaryRow | null> {
    return db
      .select()
      .from(cardHumanSummaries)
      .where(
        and(
          eq(cardHumanSummaries.companyId, companyId),
          eq(cardHumanSummaries.cardKind, cardKind),
          eq(cardHumanSummaries.cardId, cardId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /** 조회 계층 일괄 첨부용: 카드 id 목록에 대한 현재 스냅숏 맵. */
  async function getRows(companyId: string, cardKind: CardKind, cardIds: string[]): Promise<Map<string, CardSummaryRow>> {
    if (cardIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(cardHumanSummaries)
      .where(
        and(
          eq(cardHumanSummaries.companyId, companyId),
          eq(cardHumanSummaries.cardKind, cardKind),
          inArray(cardHumanSummaries.cardId, cardIds),
        ),
      );
    return new Map(rows.map((row) => [row.cardId, row]));
  }

  async function runTranslation(row: CardSummaryRow, view: CardSourceView): Promise<void> {
    const finish = (patch: Partial<typeof cardHumanSummaries.$inferInsert>) =>
      db
        .update(cardHumanSummaries)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(cardHumanSummaries.id, row.id))
        .catch((err) => logger.error({ err: String(err) }, "card summary finish update failed"));
    try {
      if (row.adapterType !== "pi_local") {
        await finish({ status: "failed", error: `adapter '${row.adapterType}' not supported yet (stage 3)` });
        return;
      }
      const output = await runCliOnce(buildPrompt(view), row.model);
      const parsed = SUMMARY_JSON_SCHEMA.safeParse(extractJson(output));
      if (!parsed.success) {
        await finish({ status: "failed", error: `summary schema validation failed: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(",")}` });
        return;
      }
      await finish({ status: "done", summaryJson: parsed.data, error: null });
    } catch (err) {
      await finish({ status: "failed", error: String(err).slice(0, 500) });
    }
  }

  function kick(row: CardSummaryRow, view: CardSourceView): void {
    if (!BACKGROUND_ENABLED) return;
    const k = key(row.companyId, row.cardKind, row.cardId);
    if (inFlight.has(k)) return;
    const p = runTranslation(row, view)
      .catch((err) => logger.error({ err: String(err) }, "card summary run failed"))
      .finally(() => { inFlight.delete(k); });
    inFlight.set(k, p);
  }

  /**
   * 조회 계층 진입점: 행이 없으면 만들고, pending/failed면(재)기동한다. 응답을 절대 막지 않는다.
   * 반환은 현재 스냅숏(원문 폴백 판단은 조회 계층 책임).
   */
  async function ensureSummary(
    companyId: string,
    cardKind: CardKind,
    cardId: string,
    view: CardSourceView,
  ): Promise<CardSummaryRow | null> {
    if (!BACKGROUND_ENABLED) return getRow(companyId, cardKind, cardId);
    const existing = await getRow(companyId, cardKind, cardId);
    if (existing) {
      if (existing.status !== "done") kick(existing, view);
      return existing;
    }
    const [created] = await db
      .insert(cardHumanSummaries)
      .values({ companyId, cardKind, cardId, adapterType: DEFAULT_ADAPTER, model: DEFAULT_MODEL })
      .onConflictDoNothing({ target: [cardHumanSummaries.companyId, cardHumanSummaries.cardKind, cardHumanSummaries.cardId] })
      .returning();
    const row = created ?? (await getRow(companyId, cardKind, cardId));
    if (row) kick(row, view);
    return row;
  }

  /** 화면의 '다시 해석': 어댑터·모델 선택 반영 후 재기동. 실패해도 4xx가 아니다(행 상태로 보고). */
  async function retranslate(
    companyId: string,
    cardKind: CardKind,
    cardId: string,
    input: { adapterType?: string; model?: string; view: CardSourceView },
  ): Promise<CardSummaryRow | null> {
    const adapterType = (input.adapterType ?? DEFAULT_ADAPTER).trim() || DEFAULT_ADAPTER;
    const model = (input.model ?? "").trim();
    await db
      .insert(cardHumanSummaries)
      .values({ companyId, cardKind, cardId, adapterType, model })
      .onConflictDoUpdate({
        target: [cardHumanSummaries.companyId, cardHumanSummaries.cardKind, cardHumanSummaries.cardId],
        set: { adapterType, model, status: "pending", summaryJson: null, error: null, updatedAt: new Date() },
      });
    const row = await getRow(companyId, cardKind, cardId);
    if (row) kick(row, input.view);
    return row;
  }

  return { getRow, getRows, ensureSummary, retranslate };
}
