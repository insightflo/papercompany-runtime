// server/src/services/missions/system-language.ts
//
// Minimal local helper for applying company `defaultLanguage` to user-visible
// server-generated prose. NOT a general i18n framework: Korean (ko) is the
// only non-English target, every other value falls back to English, and only
// narrative prose is routed through here.
//
// Machine-readable data stays English by construction because it never flows
// through this helper:
//   - HTML comment markers (`<!-- ... -->`) and structured event payloads
//   - Decision codes (`retry_source_issue`, ...) and API paths
//   - Identifier / UUID / idempotency values, status codes
//   - Legacy comment-parser contract headings and field labels
//     (`### Mission owner decision`, `Decision:`, `Source issue:`, ...)
//   - `Label:`-style structured field headers paired with control values
//
// Agent-authored text is untouched: agents already receive
// `paperclipUserFacingLanguage` through the runtime brief and choose their own
// language. This helper only covers text the server itself authors.
//
// Adding a language = one entry per prose key. Adding prose = one key + one
// opt-in call site. Legacy comment parsers are out of scope for this module.

import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";

export type SystemLanguage = "en" | "ko";

export function normalizeSystemLanguage(value: string | null | undefined): SystemLanguage {
  return value === "ko" ? "ko" : "en";
}

type ProseEntry = { readonly en: string; readonly ko: string };

const PROSE: Record<string, ProseEntry> = {
  // NOTE: workflow-created mission description prefix ("Created automatically
  // for workflow run:") is intentionally NOT localized. owner-actions.ts
  // reconcileMissionStatusFromWorkflowRuns matches it verbatim via
  // String.startsWith to detect workflow-created missions, including the
  // legacy plugin-backed path that has zero native workflowRuns. Replacing
  // that parser requires a persisted structured origin field on missions,
  // which is out of scope for this task.
  // buildMissionOwnerUnblockDescription (mission-owner-unblock-description.ts)
  owner_unblock_signal_intro: {
    en: "Mission-owner signal from oversight. This is a wakeup plus basic state/evidence; the main executor must judge and act to complete the mission.",
    ko: "오버사이트로부터 미션 오너 신호가 도착했습니다. 이 신호는 웨이크업과 기본 상태/증거일 뿐이며, 미션을 완료하려면 메인 실행자가 판단하고 행동해야 합니다.",
  },
  owner_unblock_digest_unavailable: {
    en: "Mission execution digest: unavailable for this owner action template.",
    ko: "미션 실행 요약: 이 오너 액션 템플릿에서는 사용할 수 없습니다.",
  },
  owner_unblock_governance_unavailable: {
    en: "Governance evidence: latest evidence unavailable for this owner action template.",
    ko: "거버넌스 증거: 이 오너 액션 템플릿에서는 최신 증거를 사용할 수 없습니다.",
  },
  owner_unblock_source_assignment_note: {
    en: "Source issue remains assigned to the original executor unless the structured decision is reassign_source_issue with targetAgentId.",
    ko: "구조화된 결정이 targetAgentId와 함께 reassign_source_issue인 경우가 아니면, 소스 이슈는 원래 실행자에게 할당된 상태로 유지됩니다.",
  },
  // buildRetrySourceIssueComment (mission-owner-recovery-comments.ts)
  retry_comment_heading: {
    en: "### Mission owner retry requested",
    ko: "### 미션 오너 재시도 요청",
  },
  retry_comment_action_line: {
    en: "Action: record the recovery reason and request native workflow resume; the queue runner owns the source issue state transition.",
    ko: "조치: 복구 사유를 기록하고 네이티브 워크플로우 이어달리기를 요청하세요. 소스 이슈의 상태 전환은 큐 러너가 담당합니다.",
  },
  retry_comment_default_reason: {
    en: "Owner requested source issue retry.",
    ko: "오너가 소스 이슈 재시도를 요청했습니다.",
  },
  retry_comment_instruction_label: {
    en: "Original source issue instruction:",
    ko: "원본 소스 이슈 지시문:",
  },
  retry_comment_workproducts_label: {
    en: "Active workProducts on this source issue (showing {count}):",
    ko: "이 소스 이슈의 활성 워크프로덕트 ({count}개 표시):",
  },
  // NOTE: "Latest REQUEST_CHANGES summary:" is NOT localized because
  // supervision.ts matches it verbatim via comment.includes(...) to suppress
  // duplicate REQUEST_CHANGES context comments.
};

export function prose(
  language: SystemLanguage,
  key: string,
  params?: Record<string, string | number>,
): string {
  const entry = PROSE[key];
  if (!entry) return key;
  const template = language === "ko" ? entry.ko : entry.en;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

// Loads a company's `defaultLanguage` and normalizes it. Kept inline so the
// helper stays the single seam; callers pass an existing Db handle.
export async function loadCompanySystemLanguage(
  db: Db,
  companyId: string,
): Promise<SystemLanguage> {
  const rows = await db
    .select({ defaultLanguage: companies.defaultLanguage })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows: Array<{ defaultLanguage: string | null }>) => rows[0] ?? null);
  return normalizeSystemLanguage(rows?.defaultLanguage);
}
