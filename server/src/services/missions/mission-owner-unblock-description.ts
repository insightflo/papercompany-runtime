import {
  MISSION_OWNER_DECISION_OPTIONS,
  buildMissionOwnerActionMarker,
  buildMissionOwnerDecisionFormat,
} from "./mission-owner-recovery-events.js";
import { prose, type SystemLanguage } from "./system-language.js";

type MissionOwnerDescriptionMission = {
  id: string;
  title: string;
};

type MissionOwnerDescriptionIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

export function buildMainExecutorBrief(input: {
  missionGoal: string;
  currentSituation: string;
}): string {
  return [
    "Main executor brief:",
    "Main executor role:",
    "- You own mission execution. Your goal is to complete the mission, not merely classify the alert.",
    `Mission goal: ${input.missionGoal}`,
    `Current situation: ${input.currentSituation}`,
    "Mission execution loop:",
    "- Inspect the mission goal, plan, workflow/step state, issue tree, comments, work products, and run logs.",
    "- Analyze the reported error or blocked state. If evidence is incomplete, state what is unknown and what must be checked next.",
    "- Diagnose the root cause BEFORE choosing an action: form a concrete hypothesis, then verify or refute it against evidence — did the expected artifact actually get produced (registered work products)? Was the tool invoked with the intended args (see `toolInvocationArgs` in the evidence; empty `{}` args mean the workflow definition itself lacks toolArgs)? Compare with a previously successful run of the same workflow before concluding.",
    "- BEFORE narrowing the cause from scratch, search past incident knowledge: GET /api/companies/{companyId}/knowledge-patterns?q=<keywords> for prior failure patterns with root causes and what worked. If the verified root cause is structural (likely to recur beyond this mission), record it for the next diagnosis: POST /api/companies/{companyId}/knowledge-patterns with kind=failure_mode, title, summary, symptoms, rootCause, whatWorked, and evidence refs (mission/run/issue ids).",
    "- If a recorded pattern card motivates a bounded company skill patch (one section add/replace/delete), adopt it through the self-improvement loop so provenance is kept: dry-run first (POST /api/companies/{companyId}/self-improvement-adoptions/dry-run with the candidate citing the card in evidenceSource), have the peer validator record its verdict on the returned candidateHash (POST /api/companies/{companyId}/self-improvement-adoptions/verdicts {gateOwner, candidateHash, verdict}), then POST .../self-improvement-adoptions/apply. Inlined verdicts are rejected for agent callers — the peer must record its own verdict. Avoid hand-editing skill markdown outside this loop — direct edits leave no adoption ledger.",
    "- A repeated IDENTICAL failure means your previous action did not address the root cause. Do not repeat the same action. Narrow the cause instead, and state in your decision why the next action will change the outcome.",
    "- When a diagnosis or review consensus forms quickly, state which alternative causes were considered and RULED OUT with evidence — unanimous agreement without an explicit exclusion list is a known false-positive pattern.",
    "- If the root cause is outside your authority (workflow definition edits, credentials, provider accounts, policy), do not loop retries — escalate with the precise defect, the exact change needed, and the evidence that identifies it.",
    "- Choose and perform the action that best advances the mission: instruct or wake agents, request fixes, retry/resume bounded work, request/re-run tool steps, revalidate outputs, replan, escalate, or report impossible completion with evidence.",
    "- Before requesting input or escalating, exhaust safe internal recovery first: retry_source_issue, recover_artifact, reassign_source_issue, replan_mission, or rerun/revalidate tool steps. Apply the least invasive recovery that resolves the blocker with concrete evidence.",
    "Escalation/reporting line:",
    "- If you cannot resolve the blocker because required authority, credentials, human input, external account/API access, or policy decision is missing, do not pretend the mission is recovered.",
    "- Use the existing mission-owner decision path: retry_source_issue, reassign_source_issue, replan_mission, request_input, or escalate. Do not invent a new control-plane action.",
    "- In the decision reason or next-action text, name the next assignee/owner `reportsTo` target that should receive the blocker and the evidence they need.",
    "- request_input and escalate are the LAST resort - use them only when no safe internal recovery exists, or when genuine human/operator authority, credentials, external account/API access, or a policy decision is actually required. Do not escalate merely because the blocker is unclassified.",
    "- When no runnable agent remains in the reporting line, or the blocker requires operator authority, choose request_input/escalate and request human/operator input. The human operator is the final receiver for unresolved mission blockers.",
    "- When escalating, you MUST attach the evidence and specify the concrete next action the operator must perform, and name the owner/audience (`reportsTo` target), so the request is actionable in the Human Operator menu rather than a bare status note.",
    "- Record the judgement, action taken, and next expected state so the mission can continue.",
    "Oversight signal boundary:",
    "- Treat this issue as a wakeup plus basic state/evidence from oversight. Oversight is not the recovery decision-maker.",
    "- Do not depend on normalized decision labels as the primary control path; use labels only as optional hints after judging the mission state yourself.",
    "- Do not blindly follow local classifications, perform delegated work without deciding why, or invent a recovery recipe without evidence.",
  ].join("\n");
}

export function buildMissionOwnerUnblockDescription(
  mission: MissionOwnerDescriptionMission,
  blockedIssue: MissionOwnerDescriptionIssue,
  options: { governanceEvidence?: string[]; missionExecutionDigest?: string[]; relatedKnowledgePatterns?: Array<{ id: string; title: string }>; language?: SystemLanguage } = {},
): string {
  const language = options.language ?? "en";
  const sourceLabel = blockedIssue.identifier ?? blockedIssue.id;
  const missionExecutionDigest = (options.missionExecutionDigest ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const governanceEvidence = (options.governanceEvidence ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const relatedPatterns = (options.relatedKnowledgePatterns ?? [])
    .filter((pattern) => pattern && typeof pattern.id === "string" && pattern.id.trim() !== "" && typeof pattern.title === "string" && pattern.title.trim() !== "")
    .slice(0, 3)
    .map((pattern) => ({ id: pattern.id.trim(), title: pattern.title.trim() }));
  return [
    buildMissionOwnerActionMarker({
      missionId: mission.id,
      sourceIssueId: blockedIssue.id,
      actionType: "unblock",
      status: "decision_required",
    }),
    prose(language, "owner_unblock_signal_intro"),
    "",
    `Mission id: ${mission.id}`,
    `Mission title: ${mission.title}`,
    `Source issue id: ${blockedIssue.id}`,
    `Source issue identifier: ${sourceLabel}`,
    `Source issue title: ${blockedIssue.title}`,
    `Source issue status: ${blockedIssue.status}`,
    `Original assignee agent: ${blockedIssue.assigneeAgentId ?? "unassigned"}`,
    "",
    missionExecutionDigest.length > 0
      ? ["Mission execution digest:", ...missionExecutionDigest.map((line) => `- ${line}`)].join("\n")
      : prose(language, "owner_unblock_digest_unavailable"),
    "",
    // [관련 사고 패턴 — 방아쇠 표면] 제목+카드 id 요약 라인만 주입(본문 주입 금지 계약).
    //   오너는 GET으로 전체 카드를 조회하고, 스킬 패치가 재발을 막는다면 채택 루프로 간다.
    ...(relatedPatterns.length > 0
      ? [
        `Related incident patterns (${relatedPatterns.length}) — prior structural failures in this company that may match this mission:`,
        ...relatedPatterns.map((pattern) => `- ${pattern.title} (card id: ${pattern.id})`),
        "Fetch the full card before narrowing the cause: GET /api/companies/{companyId}/knowledge-patterns?q=<keywords from the title> — check symptoms, root cause, and what worked.",
        "If a matching card means a bounded company skill patch would prevent recurrence, adopt it through the self-improvement loop: POST /api/companies/{companyId}/self-improvement-adoptions/dry-run, then /apply with the card cited in evidenceSource. Do not hand-edit skill markdown.",
        "",
      ]
      : []),
    buildMainExecutorBrief({
      missionGoal: mission.title,
      currentSituation: `Source issue ${sourceLabel} is ${blockedIssue.status}; original assignee is ${blockedIssue.assigneeAgentId ?? "unassigned"}.`,
    }),
    "",
    "Decision authority (REQUIRED control path): submit your decision through the structured API, not a comment:",
    `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`,
    "Body schema: { decision: <one of the allowed options>, sourceIssueRef?, reworkTargetRef?, targetAgentId?, reason?, nextAction?, evidence?, humanRequest? }",
    language === "ko"
      ? "request_input/escalate에만 humanRequest를 사용하세요. 먼저 현재 실행 인증으로 GET /api/issues/{this owner-action issue id}/owner-recovery/decision/current 를 조회해 lifetimeId, requestKey, recoveryNeeded, resubmit을 확인하세요. 카드 resolved만으로 복구 완료를 판단하지 마세요."
      : "Use humanRequest only with request_input/escalate. First GET /api/issues/{this owner-action issue id}/owner-recovery/decision/current with current run credentials; inspect lifetimeId, requestKey, recoveryNeeded and resubmit. A resolved card alone does not mean recovery is complete.",
    language === "ko"
      ? "같은 현재 요청의 복구가 여전히 필요하면 반환된 resubmit 전체를 requestKey와 humanRequest까지 그대로 POST하세요. 본문·hash·heartbeat로 동일성을 추정하지 마세요. 같은 요청에 resubmit이 없으면 실패를 보고하세요."
      : "For the same current request still needing recovery, POST the exact returned resubmit unchanged, including requestKey and humanRequest. Do not infer identity from body text, hash or heartbeat. If the same request has no resubmit, report the failure.",
    language === "ko"
      ? "최초 요청 또는 의도한 교체·재발에는 새 안정 requestKey를 제출 전에 한 번 선택해 보존하고 humanRequest: {schemaVersion: 1, requestKey, expectedCurrentLifetimeId: <GET의 lifetimeId>}를 포함하세요. GET의 lifetimeId:null일 때만 null을 사용하며 재시도에도 선택한 키와 본문을 유지하세요."
      : "For a first request or intentional replacement/recurrence, choose and retain a new stable requestKey once before sending and include humanRequest: {schemaVersion: 1, requestKey, expectedCurrentLifetimeId: <the GET lifetimeId>}. Use null only for GET lifetimeId:null; retain the chosen key and body across retries.",
    language === "ko"
      ? "위 POST에서 HTTP 201, eventId, lifetimeId, humanRequest.requestKey를 확인하세요. 반환 humanRequest.expectedCurrentLifetimeId는 lifetimeId와 같아야 하고, 재전달 수명은 조회값과 같으며 새 요청 수명은 달라야 합니다. 응답 유실만으로 새 키를 자동 발급하지 마세요. 선택한 키·본문을 보존하고 다시 GET한 뒤 같은 현재 요청일 때만 정확한 resubmit을 재제출하세요. 409 또는 현재 요청 변경 시 다시 조회·판단하며 예상 수명만 맹목적으로 바꾸거나 과거 키를 재사용하지 마세요."
      : "Confirm HTTP 201, eventId, lifetimeId and humanRequest.requestKey from the POST above. Returned humanRequest.expectedCurrentLifetimeId must equal lifetimeId; replay must return the queried lifetime and a new request a different lifetime. Never automatically issue a new key after response loss. Keep the chosen key/body, GET again and replay exact resubmit only for the same current request. On 409 or a different current request, re-read and explicitly reconsider; never blindly rebase the expected lifetime or reuse a past key.",
    language === "ko"
      ? "기존 안전 복구 한도를 지키고 취소된 미션을 재개·수정하지 마세요. 인증 정보는 댓글·근거에 넣지 마세요. 이 안내는 표시용이며 실행 권한이나 자연어 제어 계약이 아닙니다. 비human 결정의 기존 제출 형식과 재배정의 targetAgentId 요건은 유지됩니다."
      : "Keep existing safe recovery limits; do not resume or modify a cancelled mission or put credentials in comments/evidence. This guidance is display only, not execution authority or a natural-language control contract. Nonhuman submissions and the reassignment targetAgentId requirement remain unchanged.",
    "Allowed decision options:",
    ...MISSION_OWNER_DECISION_OPTIONS.map((decision) => `- ${decision}`),
    "When decision is reassign_source_issue, targetAgentId is REQUIRED (UUID of a same-company agent). Free-text nextAction/reason/evidence never assigns the source.",
    "The API records the authoritative structured decision bound to this company/mission/owner-action/source scope. Comments (including any 'Decision:' block below) are DISPLAY-ONLY and can no longer drive recovery — a comment alone changes nothing.",
    "",
    buildMissionOwnerDecisionFormat(),
    "",
    prose(language, "owner_unblock_source_assignment_note"),
    governanceEvidence.length > 0
      ? ["Governance evidence:", ...governanceEvidence.map((line) => `- ${line}`)].join("\n")
      : prose(language, "owner_unblock_governance_unavailable"),
  ].join("\n");
}
