import { joinPromptSections } from "./prompt-utils.js";
import { readRunToolContract } from "./run-tool-contract.js";
import { buildIssueExecutionCardBriefLines } from "./runtime-brief-card-section.js";
import { buildWorkflowReworkContractBriefLines, buildWorkflowReworkTaskHeader } from "./runtime-brief-rework-section.js";
import { buildQaCapAcceptanceBriefLines } from "./runtime-brief-qa-cap-section.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function truncateBriefLine(value: string, max = 260) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function stringifyBriefJson(value: unknown, max = 1_000) {
  try {
    return truncateBriefLine(JSON.stringify(value ?? {}), max);
  } catch {
    return "{}";
  }
}

function extractSchemaDefaults(schema: Record<string, unknown> | null): Record<string, unknown> {
  const properties = asRecord(schema?.properties);
  if (!properties) return {};

  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = asRecord(value);
    if (!property || !Object.prototype.hasOwnProperty.call(property, "default")) continue;
    defaults[key] = property.default;
  }
  return defaults;
}

function buildWorkflowToolContractBrief(context: unknown) {
  const parsed = readRunToolContract(context);
  if (!parsed) return null;
  const contract: Record<string, unknown> = {
    ...parsed.raw,
    stepName: parsed.stepName,
    stepId: parsed.stepId,
    toolNames: parsed.toolNames,
    toolArgs: parsed.toolArgs,
    tools: parsed.tools,
  };

  const tools = Array.isArray(contract.tools)
    ? contract.tools.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const toolNames = [
    ...asStringArray(contract.toolNames),
    ...tools.map((tool) => asString(tool.name)).filter((value): value is string => value !== null),
  ].filter((value, index, all) => all.indexOf(value) === index);
  if (toolNames.length === 0 && !asString(contract.stepName) && !asString(contract.stepId)) return null;

  const toolLines = tools.length > 0
    ? tools.slice(0, 8).flatMap((tool) => {
        const name = asString(tool.name) ?? "unknown-tool";
        const description = asString(tool.description);
        const inputSchema = asRecord(tool.inputSchema ?? tool.parametersSchema);
        const instructions = asString(tool.instructions);
        return [
          `- Tool: ${name}${description ? ` — ${truncateBriefLine(description, 180)}` : ""}`,
          inputSchema && Object.keys(inputSchema).length > 0
            ? `  Parameter schema: ${stringifyBriefJson(inputSchema, 1_200)}`
            : null,
          instructions ? `  Instructions: ${truncateBriefLine(instructions, 400)}` : null,
        ].filter((line): line is string => line !== null);
      })
    : (toolNames.length > 0 ? [`- Tools: ${toolNames.join(", ")}`] : []);
  const primaryToolName = toolNames[0] ?? "<registered-tool-name>";
  const primaryTool = tools.find((tool) => asString(tool.name) === primaryToolName) ?? tools[0] ?? null;
  const primaryInputSchema = primaryTool ? asRecord(primaryTool.inputSchema ?? primaryTool.parametersSchema) : null;
  const schemaDefaults = extractSchemaDefaults(primaryInputSchema);
  const rawWorkflowStepArgs = contract.toolArgs ?? {};
  const workflowStepArgs = asRecord(rawWorkflowStepArgs);
  const effectiveParameters = workflowStepArgs
    ? {
        ...schemaDefaults,
        ...workflowStepArgs,
      }
    : rawWorkflowStepArgs;
  const workflowStepArgsJson = stringifyBriefJson(rawWorkflowStepArgs);
  const effectiveParametersJson = stringifyBriefJson(effectiveParameters);

  return joinPromptSections([
    "Workflow tool-call contract:",
    asString(contract.stepName) ? `Step: ${asString(contract.stepName)}` : asString(contract.stepId) ? `Step: ${asString(contract.stepId)}` : null,
    toolNames.length > 0 ? `Allowed workflow tools: ${toolNames.join(", ")}` : null,
    ...toolLines,
    `Workflow step args: ${workflowStepArgsJson}`,
    `Effective HTTP parameters: ${effectiveParametersJson}`,
    "Use the Effective HTTP parameters above as the HTTP `parameters` JSON unless the assigned issue explicitly overrides them.",
    `Agent HTTP invocation: POST $PAPERCLIP_API_BASE_URL/plugins/tools/execute with Authorization: Bearer $PAPERCLIP_API_KEY and JSON {"tool":"${primaryToolName}","parameters":${effectiveParametersJson},"runContext":{"agentId":"$PAPERCLIP_AGENT_ID","runId":"$PAPERCLIP_RUN_ID","companyId":"$PAPERCLIP_COMPANY_ID"}}.`,
  ], "\n");
}

// [runaway recovery] 직전 실행이 폭주(재고민 루프)로 종료된 경우, 다음 실행 선두에 붙는 회복 지시.
//   kill 대신 모델 스스로 마무리하게 유도하는 deepseek-harness식 권고 패턴을 웨이크에 적용한 것.
function buildRunawayRecoveryBriefLines(value: unknown): readonly string[] {
  const record = asRecord(value);
  if (record?.kind !== "runaway_recovery") return [];
  const logBytes = asNumber(record.logBytes);
  const mb = Math.round(logBytes / (1024 * 1024));
  return [
    "=== RUNAWAY RECOVERY ADVISORY (read first) ===",
    `- Your previous run on this issue was terminated by the runaway guard after producing ~${mb > 0 ? mb : "<1"}MB of output without finishing.`,
    "- That pattern almost always means endless re-reasoning over the same feedback instead of acting.",
    "- This run: (1) restate in a short list the conclusions you already reached, (2) complete or fix the deliverable directly at the registered path, (3) submit/finish.",
    "- Do NOT start another full review or re-derivation pass over the same material.",
    "=== end runaway recovery advisory ===",
  ];
}

// [no-progress recovery] 직전 성공 run들이 모두 무진행(구조화 증거 없음)이었을 때 다음 실행 선두에 붙는 회복 지시.
//   어드바이저(soft event) 다음 단계 — 같은 탐색 반복 대신 최소 산출물 등록 또는 정직한 blocked 요청만 유도한다.
//   지시 준수 여부는 다음 run의 DB 증거로만 재판정된다(이 텍스트 자체는 근거가 아님).
function buildNoProgressRecoveryBriefLines(value: unknown): readonly string[] {
  const record = asRecord(value);
  if (record?.kind !== "no_progress_recovery") return [];
  const consecutiveCount = asNumber(record.consecutiveCount);
  const autoBlockThreshold = asNumber(record.autoBlockThreshold);
  return [
    "=== NO-PROGRESS RECOVERY ADVISORY (read first) ===",
    `- Your last ${consecutiveCount} completed runs on this issue left no structured trace: no registered work product, no issue comment, no workflow transition.`,
    autoBlockThreshold > 0
      ? `- After ${autoBlockThreshold} consecutive runs like this the issue is auto-blocked and will not be dispatched again until the owner intervenes.`
      : "- Repeated unchanged runs are tracked; do not rely on redispatch.",
    "- This run MUST end with ONE of: (1) register the minimum required work product via the Workflow API, or (2) explicitly report blocked with the concrete blocker reason as an issue comment.",
    "- Do NOT repeat the same exploration, re-derivation, or output-only pass over the same material.",
    "=== end no-progress recovery advisory ===",
  ];
}

// [operator decision delivery] 오너 결정 카드가 해결되면 wake contextSnapshot 에 실려 오는
//   paperclipOperatorDecisionResolution 를 brief 상단 우선 블록으로 렌더한다(fresh-run 전달 계층).
//   규칙 8: 이 텍스트는 전달용이며 권위는 operator_decisions.result + activity log 에 있다.
function buildOperatorDecisionResolutionBriefLines(value: unknown): readonly string[] {
  const record = asRecord(value);
  if (!record) return [];
  const operatorDecisionId = asString(record.operatorDecisionId);
  if (!operatorDecisionId) return [];
  const options = Array.isArray(record.options)
    ? record.options.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const optionLines = options.flatMap((option) => {
    const label = asString(option.label) ?? asString(option.id);
    if (!label) return [];
    const description = asString(option.description);
    return [`- Operator decision resolved (card): ${label}${description ? ` — ${truncateBriefLine(description, 300)}` : ""}`];
  });
  return [
    "Operator decision resolution — priority instruction (read first):",
    ...optionLines,
    `- operatorDecisionId: ${operatorDecisionId}`,
    "이 결정은 운영자가 카드에서 선택한 우선 지시다.",
  ];
}

function buildRecentIssueCommentsBrief(value: unknown) {
  const comments = Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const lines = comments
    .slice(0, 5)
    .map((comment) => {
      const body = asString(comment.body ?? comment.content ?? comment.text);
      if (!body) return null;
      const authorType = asString(comment.authorType) ?? (asString(comment.authorUserId) ? "controller" : asString(comment.authorAgentId) ? "agent" : "unknown");
      const commentId = asString(comment.id);
      return `- ${authorType}${commentId ? `/${commentId}` : ""}: ${truncateBriefLine(body)}`;
    })
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;

  return joinPromptSections([
    "Recent issue comments:",
    ...lines,
  ], "\n");
}

function artifactRefForWorkProduct(product: Record<string, unknown>) {
  const metadata = asRecord(product.metadata);
  return (
    asString(product.url) ??
    asString(product.externalId) ??
    asString(metadata?.path) ??
    (metadata && Object.keys(metadata).length > 0 ? stringifyBriefJson(metadata, 500) : null)
  );
}

function buildWorkItemEvidenceLines(label: string, item: Record<string, unknown>) {
  const identifier = asString(item.identifier) ?? asString(item.id) ?? "unknown";
  const title = asString(item.title);
  const status = asString(item.status);
  const description = asString(item.description);
  const workProducts = asRecord(item.workProducts);
  const latestProducts = Array.isArray(workProducts?.latest)
    ? workProducts!.latest.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const latestComments = Array.isArray(item.latestComments)
    ? item.latestComments.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const lines = [
    `- ${label}: ${identifier}${title ? ` — ${truncateBriefLine(title, 180)}` : ""}${status ? ` (${status})` : ""}`,
    description ? `  Description: ${truncateBriefLine(description, 700)}` : null,
    `  Work products: ${asNumber(workProducts?.total)}`,
    ...latestProducts.slice(0, 5).map((product) => {
      const productTitle = asString(product.title) ?? asString(product.id) ?? "workProduct";
      const productType = asString(product.type) ?? "unknown";
      const productStatus = asString(product.status) ?? "unknown";
      const provider = asString(product.provider);
      const artifactRef = artifactRefForWorkProduct(product);
      return `  - ${productTitle} [${productType}/${productStatus}]${provider ? ` provider=${provider}` : ""}${artifactRef ? ` ref=${truncateBriefLine(artifactRef, 420)}` : ""}`;
    }),
    latestComments.length > 0 ? "  Latest comments:" : null,
    ...latestComments.slice(-5).map((comment) => {
      const body = asString(comment.body ?? comment.content ?? comment.text);
      if (!body) return null;
      const author = asString(comment.authorUserId) ?? asString(comment.authorAgentId) ?? "unknown";
      const createdAt = asString(comment.createdAt);
      return `  - ${createdAt ? `${createdAt} ` : ""}${author}: ${truncateBriefLine(body, 900)}`;
    }),
  ].filter((line): line is string => line !== null);
  return lines;
}

function buildCurrentPageIssueEvidence(currentPage: Record<string, unknown> | null) {
  const facts = asRecord(currentPage?.facts);
  if (!facts) return [];
  const selected = asRecord(facts.selectedWorkItem);
  const attention = Array.isArray(facts.attentionWorkItems)
    ? facts.attentionWorkItems.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const lines = [
    ...(selected ? buildWorkItemEvidenceLines("Selected work item", selected) : []),
    ...attention.slice(0, 4).flatMap((item, index) => buildWorkItemEvidenceLines(`Attention work item ${index + 1}`, item)),
  ];
  if (lines.length === 0) return [];
  return [
    "Current page issue evidence:",
    "Use this section before the summary/Facts JSON for blocked, failed, QA, artifact, or workProduct questions.",
    ...lines,
  ];
}

// [P2] recovery advice(structured MissionRecoveryAdvice)를 compact prompt 섹션으로 직렬화.
//   server의 MissionRecoveryAdvice 타입을 import 할 수 없으니(의존성 방향) 구조적으로 안전 읽기.
//   advice가 있으면 caller가 facts JSON을 생략한다(결정에 불필요한 중복 컨텍스트 감소).
function buildRecoveryAdviceLines(value: unknown): string[] | null {
  const advice = asRecord(value);
  if (!advice) return null;
  const decision = asString(advice.decision);
  if (!decision) return null;

  const target = asRecord(advice.targetIssue);
  const targetAction = asString(advice.targetAction);
  const leafCause = asString(advice.leafCause);
  const operatorComment = asString(advice.operatorComment);
  const executionInstruction = asString(advice.executionInstruction);
  const evidence = Array.isArray(advice.evidence)
    ? advice.evidence.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    : [];
  const doNot = Array.isArray(advice.doNot)
    ? advice.doNot.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  const missingEvidence = Array.isArray(advice.missingEvidence)
    ? advice.missingEvidence.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];
  const successEvidence = Array.isArray(advice.successEvidence)
    ? advice.successEvidence.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];
  const targetIdentifier = asString(target?.identifier) ?? asString(target?.id);
  const targetRole = asString(target?.role);
  const targetTitle = asString(target?.title);

  const lines = [
    "Recovery advice (structured — prefer this for recovery/QA/blocked/stuck questions):",
    `- Decision: ${decision}`,
    targetIdentifier
      ? `- Target: ${targetIdentifier}${targetRole ? ` (${targetRole})` : ""}${targetTitle ? ` — ${truncateBriefLine(targetTitle, 160)}` : ""}`
      : null,
    targetAction ? `- Action: ${targetAction}` : null,
    leafCause ? `- Leaf cause: ${truncateBriefLine(leafCause, 800)}` : null,
    evidence.length > 0 ? "Evidence:" : null,
    ...evidence.slice(0, 5).map((e) => `- ${asString(e.label) ?? "evidence"}: ${truncateBriefLine(asString(e.value) ?? "", 300)}`),
    doNot.length > 0 ? "Do NOT:" : null,
    ...doNot.slice(0, 6).map((d) => `- ${truncateBriefLine(d, 300)}`),
    missingEvidence.length > 0 ? "Missing evidence (state to operator plainly — do not hide):" : null,
    ...missingEvidence.slice(0, 5).map((m) => `- ${truncateBriefLine(m, 300)}`),
    operatorComment ? "Operator comment (paste-ready Korean):" : null,
    operatorComment ? truncateBriefLine(operatorComment, 1200) : null,
    executionInstruction ? "Execution instruction:" : null,
    executionInstruction ? truncateBriefLine(executionInstruction, 1200) : null,
    successEvidence.length > 0 ? "Success evidence to verify after acting:" : null,
    ...successEvidence.slice(0, 5).map((m) => `- ${truncateBriefLine(m, 300)}`),
    "Answer rules for recovery questions:",
    "- Include: target issue, action, reason (leaf cause), key evidence, the paste-ready operator comment, execution instruction, success evidence, and the do-not list.",
    "- If decision is supervision_run, say to run mission-owner supervision next. If human_operator, say manual judgment is required.",
    "- If the operator asks you to execute/wake/rework, follow Execution instruction and then verify Success evidence. A plain comment on a done issue is not a wake.",
  ].filter((line): line is string => line !== null);
  return lines.length > 1 ? lines : null;
}

function buildHermesChatBrief(value: unknown) {
  const chat = asRecord(value);
  if (!chat) return null;

  const currentMessage = asString(chat.currentMessage);
  const sessionId = asString(chat.sessionId);
  const sessionTitle = asString(chat.sessionTitle);
  const recentMessages = Array.isArray(chat.recentMessages)
    ? chat.recentMessages.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const instructions = Array.isArray(chat.instructions)
    ? chat.instructions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const currentPage = asRecord(chat.currentPage);
  const attachments = Array.isArray(chat.attachments)
    ? chat.attachments.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];

  if (!currentMessage && recentMessages.length === 0) return null;

  const messageLines = recentMessages.slice(-14).map((message) => {
    const role = asString(message.role) ?? "message";
    const body = asString(message.body);
    if (!body) return null;
    return `- ${role}: ${truncateBriefLine(body, 420)}`;
  }).filter((line): line is string => line !== null);
  const recoveryAdviceLines = buildRecoveryAdviceLines(chat.recoveryAdvice);
  const hasStructuredAdvice = recoveryAdviceLines !== null;
  const currentPageFacts = asRecord(currentPage?.facts);
  // [P2] structured recovery advice가 있으면 full facts JSON을 생략한다 — advice가 결정적 evidence를
  //   compact하게 제공하므로 중복 대형 컨텍스트가 prompt를 잡아먹지 않는다(peer P2 acceptance).
  const currentPageFactsLine = !hasStructuredAdvice && currentPageFacts && Object.keys(currentPageFacts).length > 0
    ? truncateBriefLine(JSON.stringify(currentPageFacts), 4_000)
    : null;
  const currentPageIssueEvidenceLines = buildCurrentPageIssueEvidence(currentPage);
  const attachmentLines = attachments.slice(0, 6).flatMap((attachment) => {
    const name = asString(attachment.name) ?? "attachment";
    const contentType = asString(attachment.contentType) ?? "application/octet-stream";
    const kind = asString(attachment.kind) ?? (contentType.startsWith("image/") ? "image" : "file");
    const size = typeof attachment.size === "number" ? attachment.size : null;
    const text = asString(attachment.text);
    return [
      `- ${kind}: ${name} (${contentType}${size !== null ? `, ${size} bytes` : ""})`,
      text ? `  Content excerpt: ${truncateBriefLine(text, 1_500)}` : null,
    ].filter((line): line is string => line !== null);
  });

  return joinPromptSections([
    "Hermes web chat:",
    sessionId ? `- Session: ${sessionId}` : null,
    sessionTitle ? `- Title: ${sessionTitle}` : null,
    instructions.length > 0 ? "Instructions:" : null,
    ...instructions.slice(0, 10).map((instruction) => `- ${instruction}`),
    ...(recoveryAdviceLines ?? []),
    ...currentPageIssueEvidenceLines,
    currentPage ? "Current Paperclip page:" : null,
    asString(currentPage?.kind) ? `- Kind: ${asString(currentPage?.kind)}` : null,
    asString(currentPage?.path) ? `- Path: ${asString(currentPage?.path)}` : null,
    asString(currentPage?.title) ? `- Title: ${asString(currentPage?.title)}` : null,
    asString(currentPage?.status) ? `- Status: ${asString(currentPage?.status)}` : null,
    asString(currentPage?.summary) ? `- Summary: ${truncateBriefLine(asString(currentPage?.summary)!, 420)}` : null,
    currentPageFactsLine ? `- Facts: ${currentPageFactsLine}` : null,
    attachmentLines.length > 0 ? "Current operator attachments:" : null,
    ...attachmentLines,
    messageLines.length > 0 ? "Recent conversation:" : null,
    ...messageLines,
    currentMessage ? "Current operator message:" : null,
    currentMessage ? currentMessage : null,
  ], "\n");
}

function summarizeMarkdownHandoff(markdown: string | null) {
  const trimmed = markdown?.trim();
  if (!trimmed) return null;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const summary = lines.join(" ");
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function buildMissionOwnerPlanningToolDetails(missionOwnerPlanningContext: Record<string, unknown>) {
  const planningDossier = asRecord(missionOwnerPlanningContext.planningDossier);
  const assets = asRecord(planningDossier?.assets);
  const tools = asRecord(assets?.tools);
  const rawEntries = Array.isArray(missionOwnerPlanningContext.planningDossierToolEntries)
    ? missionOwnerPlanningContext.planningDossierToolEntries
    : tools?.entries;
  const entries = Array.isArray(rawEntries)
    ? rawEntries.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  if (entries.length === 0) return [];

  return [
    "Planning dossier tool contracts (description and input schema; Tool instructions are intentionally omitted):",
    ...entries.slice(0, 10).flatMap((entry) => {
      const name = asString(entry.name) ?? "unknown-tool";
      const displayName = asString(entry.displayName);
      const description = asString(entry.description);
      const inputSchema = asRecord(entry.inputSchema);
      const planningMetadata = asRecord(entry.planningMetadata);
      const acceptedInputKinds = asStringArray(planningMetadata?.acceptedInputKinds);
      return [
        `- Tool: ${name}${displayName && displayName !== name ? ` (${displayName})` : ""}${description ? ` — ${truncateBriefLine(description, 260)}` : ""}`,
        inputSchema && Object.keys(inputSchema).length > 0
          ? `  Input schema: ${stringifyBriefJson(inputSchema, 1_200)}`
          : "  Input schema: {}",
        acceptedInputKinds.length > 0 ? `  Accepted input kinds: ${acceptedInputKinds.join(", ")}` : null,
      ].filter((line): line is string => line !== null);
    }),
  ];
}

function buildMissionOwnerPlanningProtocol(missionOwnerPlanningContext: Record<string, unknown> | null) {
  if (missionOwnerPlanningContext?.available !== true) return null;

  const planningDossierAssetCounts = asRecord(missionOwnerPlanningContext.planningDossierAssetCounts);
  const missionId = asString(missionOwnerPlanningContext.missionId) ?? "unknown";
  const planningIssueId = asString(missionOwnerPlanningContext.planningIssueId) ?? "none";
  const activePlanState = missionOwnerPlanningContext.activePlanAvailable === true ? "yes" : "no";
  const assetCountsLine = planningDossierAssetCounts
    ? `- Planning dossier asset-count summary: workflows ${asNumber(planningDossierAssetCounts.workflowCandidates)}, tools ${asNumber(planningDossierAssetCounts.tools)}, runtime service assets ${asNumber(planningDossierAssetCounts.runtimeServices)}, rules ${asNumber(planningDossierAssetCounts.ruleRefs)}, KB ${asNumber(planningDossierAssetCounts.kbRefs)}, agents ${asNumber(planningDossierAssetCounts.agentRoster)}, files ${asNumber(planningDossierAssetCounts.fileViews)}, execution source units ${asNumber(planningDossierAssetCounts.executionSourceUnits)}.`
    : "- Planning dossier asset-count summary: unavailable.";

  return joinPromptSections([
    `Mission owner planning context: mission ${missionId}, planning issue ${planningIssueId}, active plan ${activePlanState}, selected units ${asNumber(missionOwnerPlanningContext.selectedExecutionUnitCount)}, execution source units ${asNumber(missionOwnerPlanningContext.executionSourceUnitCount)}.`,
    "Owner planning protocol:",
    "Produce a Mission Planning Assessment before acting beyond status discovery.",
    "Use dossier asset counts as pointers only. Missing tool/runtime-service assets do not prove that the Paperclip worker runtime is down.",
    assetCountsLine,
    ...buildMissionOwnerPlanningToolDetails(missionOwnerPlanningContext),
    `- Planning dossier gaps: ${asNumber(missionOwnerPlanningContext.planningDossierGapCount)} total, ${asNumber(missionOwnerPlanningContext.planningDossierSevereGapCount)} severe/blocking-or-research gaps.`,
    "Common operating boundary:",
    "Stay within your assigned role, authority, and issue scope. Do not perform work that belongs to another role just because you can reach a tool.",
    "When required work is outside your scope, escalate to the appropriate owner/director/mission controller if one is available, leave a concise status or handoff, and stop this run within your own scope.",
    "If there is no valid escalation path, end blocked/error with the missing path or authority. Do not replace escalation with improvised execution.",
    "Director boundary:",
    "A director or mission owner plans, delegates, reviews, and decides gates; it is not a source-research or report-production worker.",
    "Mission issue grouping is WBS-style: `[PLAN]` issues produce the work structure and then close; `[ACTION]`, `[QA]`, and `[OVERSIGHT]` issues are mission-level siblings by default, not children of the PLAN issue.",
    "When materializing plan output, create `[ACTION] ...`, `[QA] ...`, and `[OVERSIGHT] ...` issues with missionId set and parentId empty. Use parent-child only to decompose a single ACTION into smaller action sub-issues.",
    "After handing off bounded mission-level ACTION/QA work, do not wait by doing the child work yourself. If child runtime health is unclear or unavailable, escalate or block via OVERSIGHT instead of using internal Agent/Task/WebSearch/WebFetch/Bash as a source-research or report-production substitute.",
    "Bash remains for in-scope Paperclip API/status/file inspection only; do not use it to bypass role boundaries.",
    "Dynamic workflow means reducing uncertainty with evidence gates, not adding subagents or parallelism by default.",
    "Paperclip child issues are the delegation mechanism for mission work; internal local-agent delegation is not a replacement for out-of-scope work.",
    "Report slice completion separately from end-to-end completion.",
    "Choose exactly one branch:",
    "1. `research_needed`: name missing evidence and the intended delegation/escalation path.",
    "2. `blocked`: name the missing input, authority, runtime path, or escalation path.",
    "3. `ready_to_plan`: emit the structured JSON block below.",
    "Do not mark the planning issue done until a structured plan decision has been posted and materialized as mission-level sibling issues, or the mission is explicitly completed with evidence and a final completion comment.",
    "Do not include `selfImprovementCandidates` unless every entry follows the full self-improvement candidate object contract.",
    "Before improvising an answer that needs a missing capability, check existing tools/skills first; propose the gap as a `tool` assetType self-improvement candidate with `toolGap.capability` and `toolGap.existingToolsTried`.",
    "Tool/structural-gate execution units must declare concrete `toolArgs` (validators: `dir: {$steps.<producerUnitId>.workProductDir}`, `glob: *.html`); a tool step without args cannot execute and the plan will be rejected.",
    "Accepted marker and JSON block:",
    "### Mission owner plan decision",
    "```json",
    JSON.stringify(
      {
        decisionType: "mission_owner_plan",
        missionId,
        summary: "...",
        missionInvariant: [],
        scopeHypothesis: "...",
        executionSlice: {
          inScope: [],
          outOfScope: [],
          approvalGates: [],
        },
        evidenceRequired: [],
        gate: {
          validator: "...",
          pass: [],
          requestChanges: [],
          blocked: [],
        },
        promotion: {
          promote: [],
          doNotPromote: [],
        },
        assessment: {
          objectiveRestatement: "...",
          availableAssetsReviewed: [],
          assetEvaluation: [],
          gaps: [],
          researchPerformed: [],
        },
        steps: [],
        requiredInputs: [],
        successCriteria: [],
        risks: [],
        selectedExecutionUnits: [],
        ruleRefs: [],
        kbRefs: [],
      },
      null,
      2,
    ),
    "```",
  ], "\n");
}

export function buildPaperclipRuntimeBrief(context: Record<string, unknown>) {
  const manifest = asRecord(context.paperclipStepInputManifest);
  const handoff = asRecord(context.paperclipSessionHandoff);
  const issueExecutionCard = asRecord(context.paperclipIssueExecutionCard);
  const instructionInjection = asRecord(context.paperclipInstructionInjection);
  const workflowReworkContractLines = buildWorkflowReworkContractBriefLines(context.paperclipWorkflowReworkContract);
  const qaCapAcceptanceLines = buildQaCapAcceptanceBriefLines(context.paperclipQaCapAcceptanceContract);
  // [QA rework] rework 선두 헤더 + rework 모드 여부. 헤더는 brief 시작에, 상세 contract 라인은 기존 위치 유지.
  const reworkHeaderLines = buildWorkflowReworkTaskHeader(context.paperclipWorkflowReworkContract);
  // [runaway recovery] 재고민 루프로 죽은 직후 재시동되는 실행에는 회복 지시를 최상단에.
  const runawayRecoveryLines = buildRunawayRecoveryBriefLines(context.paperclipRunawayRecoveryBrief);
  const noProgressRecoveryLines = buildNoProgressRecoveryBriefLines(context.paperclipNoProgressRecoveryBrief);
  const isReworkMode = reworkHeaderLines.length > 0;
  const workflowToolContractLine = buildWorkflowToolContractBrief(context);
  // [QA rework] rework contract가 최신 QA feedback을 이미 가지면 최근 코멘트는 중복이므로 억제(prompt dilution 방지).
  const recentIssueCommentsLine = isReworkMode ? null : buildRecentIssueCommentsBrief(context.paperclipIssueRecentComments);
  const hermesChatLine = buildHermesChatBrief(context.paperclipHermesChat);

  const taskKey = asString(manifest?.taskKey ?? context.taskKey);
  const issueId = asString(manifest?.issueId ?? context.issueId);
  const projectId = asString(manifest?.projectId ?? context.projectId);
  const allowedKeys = Array.isArray(manifest?.allowedContextKeys)
    ? manifest!.allowedContextKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const manifestInputs = asRecord(manifest?.inputs);
  const workspace = asRecord(manifestInputs?.workspace);
  const runtimeServices = asRecord(manifestInputs?.runtimeServices);
  const tools = asRecord(manifestInputs?.tools);
  const knowledge = asRecord(manifestInputs?.knowledge);
  const maintenanceGuidance = asRecord(manifestInputs?.maintenanceGuidance);
  const maintenanceDecision = asRecord(manifestInputs?.maintenanceDecision);
  const fileViews = asRecord(manifestInputs?.fileViews);
  const missionPlan = asRecord(manifestInputs?.missionPlan);
  const missionWorkingNote = asRecord(manifestInputs?.missionWorkingNote);
  const missionOwnerPlanningContext = asRecord(manifestInputs?.missionOwnerPlanningContext);
  const missionSearch = asRecord(manifestInputs?.missionSearch);
  const userFacingLanguage = asString(context.paperclipUserFacingLanguage);
  const missionSearchScopes = Array.isArray(missionSearch?.allowedScopes)
    ? missionSearch.allowedScopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const guardrails = asRecord(manifest?.guardrails);

  const workspaceLine =
    workspace?.available === true
      ? [
          "- Workspace: available",
          asString(workspace.source) ? `(${asString(workspace.source)})` : "",
          asString(workspace.workspaceId) ? `[${asString(workspace.workspaceId)}]` : "",
        ].filter(Boolean).join(" ")
      : "- Workspace: unavailable";

  const runtimeServicesLine =
    runtimeServices?.available === true
      ? `- Runtime service assets listed in dossier: ${Number(runtimeServices.count ?? 0)}${asString(runtimeServices.primaryUrl) ? ` (${asString(runtimeServices.primaryUrl)})` : ""}. This is not a Paperclip worker-runtime health signal.`
      : "- No runtime service assets are listed in this dossier. This is not a Paperclip worker-runtime health signal.";

  const fileViewsLine =
    fileViews?.available === true
      ? `- File views: ${Number(fileViews.count ?? 0)} available${asString(fileViews.source) ? ` (${asString(fileViews.source)})` : ""}`
      : null;

  const toolsLine =
    tools?.available === true
      ? `- Allowed tools: ${Array.isArray(tools.names) && tools.names.length > 0 ? tools.names.join(", ") : `${Number(tools.count ?? 0)} configured`}`
      : null;

  const knowledgeLine =
    knowledge?.available === true
      ? `- Knowledge: ${Array.isArray(knowledge.names) && knowledge.names.length > 0 ? knowledge.names.join(", ") : `${Number(knowledge.count ?? 0)} connected`}`
      : null;

  const maintenanceGuidanceLine =
    maintenanceGuidance?.available === true
      ? `- Maintenance guidance: ${Number(maintenanceGuidance.ruleCount ?? 0)} rules, ${Number(maintenanceGuidance.knowledgeCount ?? 0)} KB references`
      : null;

  const maintenanceRuleLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.ruleNames) && maintenanceGuidance.ruleNames.length > 0
      ? `- Rules: ${maintenanceGuidance.ruleNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ")}`
      : null;

  const maintenanceRuleExcerptLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.ruleExcerpts) && maintenanceGuidance.ruleExcerpts.length > 0
      ? `- Rule excerpts: ${maintenanceGuidance.ruleExcerpts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" | ")}`
      : null;

  const maintenanceKnowledgeLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.knowledgeNames) && maintenanceGuidance.knowledgeNames.length > 0
      ? `- Guidance KB: ${maintenanceGuidance.knowledgeNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ")}`
      : null;

  const maintenanceKnowledgeExcerptLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.knowledgeExcerpts) && maintenanceGuidance.knowledgeExcerpts.length > 0
      ? `- Guidance KB excerpts: ${maintenanceGuidance.knowledgeExcerpts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" | ")}`
      : null;

  const maintenanceDecisionLine =
    maintenanceDecision?.available === true && asString(maintenanceDecision.recommendedNextAction)
      ? `- Maintenance decision: ${asString(maintenanceDecision.recommendedNextAction)} (suggested status: ${asString(maintenanceDecision.suggestedStatus) ?? "none"})`
      : null;

  const maintenanceDecisionRequiredInputsLine =
    maintenanceDecision?.available === true && Array.isArray(maintenanceDecision.requiredInputs)
      ? `- Required inputs: ${maintenanceDecision.requiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ") || "none"}`
      : null;

  const maintenanceDecisionWarningsLine =
    maintenanceDecision?.available === true && Array.isArray(maintenanceDecision.warnings)
      ? `- Decision warnings: ${maintenanceDecision.warnings.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ") || "none"}`
      : null;

  const maintenanceDecisionHandoffLine =
    maintenanceDecision?.available === true && asString(maintenanceDecision.handoffTarget)
      ? `- Handoff target: ${asString(maintenanceDecision.handoffTarget)}`
      : null;

  const maintenanceRoleContext = asRecord(maintenanceDecision?.roleContext);
  const maintenanceRoles = Array.isArray(maintenanceRoleContext?.roles)
    ? maintenanceRoleContext.roles.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceRoleQuestions = Array.isArray(maintenanceRoleContext?.questions)
    ? maintenanceRoleContext.questions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const maintenanceRoleContextLine =
    maintenanceDecision?.available === true && maintenanceRoles.length > 0
      ? `- Maintenance role context: ${maintenanceRoles
          .map((role) => {
            const metadata = asRecord(role.metadata);
            const aliases = Array.isArray(metadata?.aliases)
              ? metadata.aliases.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [];
            return [
              asString(role.id),
              asString(role.kind) ? `(${asString(role.kind)})` : null,
              aliases.length > 0 ? `[aliases: ${aliases.join(", ")}]` : null,
            ].filter(Boolean).join(" ");
          })
          .filter(Boolean)
          .join(", ")}`
      : null;
  const maintenanceRoleQuestionsLine =
    maintenanceDecision?.available === true && maintenanceRoleQuestions.length > 0
      ? `- Role alignment questions: ${maintenanceRoleQuestions.join(" | ")}`
      : null;

  const missionPlanStepSummary = Array.isArray(missionPlan?.stepSummary)
    ? missionPlan.stepSummary.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanOpenInputs = Array.isArray(missionPlan?.openRequiredInputs)
    ? missionPlan.openRequiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanLine =
    missionPlan?.available === true && asString(missionPlan.missionGoal)
      ? `- Mission plan: rev ${Number(missionPlan.revision ?? 0)} ${asString(missionPlan.status) ?? "unknown"} — ${asString(missionPlan.missionGoal)}`
      : null;
  const missionPlanInputsLine =
    missionPlan?.available === true
      ? `- Mission plan inputs: ${Number(missionPlan.requiredInputsCount ?? 0)} required, open: ${missionPlanOpenInputs.join(", ") || "none"}`
      : null;
  const missionPlanStepsLine =
    missionPlan?.available === true
      ? `- Mission plan steps: ${Number(missionPlan.stepCount ?? 0)} total${missionPlanStepSummary.length > 0 ? ` — ${missionPlanStepSummary.join(" | ")}` : ""}`
      : null;
  const missionPlanRuleNames = Array.isArray(missionPlan?.ruleNames)
    ? missionPlan.ruleNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanRuleModes = Array.isArray(missionPlan?.ruleModes)
    ? missionPlan.ruleModes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const selectedUnitSelectionCounts = asRecord(missionPlan?.selectedExecutionUnitSelectionStateCounts);
  const selectedUnitExecutionCounts = asRecord(missionPlan?.selectedExecutionUnitExecutionStateCounts);
  const selectedUnitLabels = Array.isArray(missionPlan?.selectedExecutionUnitLabels)
    ? missionPlan.selectedExecutionUnitLabels.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 3)
    : [];
  const missionPlanExecutionUnitsLine =
    missionPlan?.available === true && Number(missionPlan.executionUnitCount ?? 0) > 0
      ? `- Mission execution units: ${Number(missionPlan.executionUnitCount ?? 0)} total, ${Number(missionPlan.blockedOrFailedUnitCount ?? 0)} blocked/failed`
      : null;
  const missionPlanSelectedUnitsLine =
    missionPlan?.available === true && asNumber(missionPlan.selectedExecutionUnitCount) > 0
      ? `- Mission selected units: ${asNumber(missionPlan.selectedExecutionUnitCount)} total — selected ${asNumber(selectedUnitSelectionCounts?.selected)}, candidate ${asNumber(selectedUnitSelectionCounts?.candidate)}, excluded ${asNumber(selectedUnitSelectionCounts?.excluded)}, satisfied ${asNumber(selectedUnitSelectionCounts?.satisfied)}; blocked ${asNumber(selectedUnitExecutionCounts?.blocked)}, failed ${asNumber(selectedUnitExecutionCounts?.failed)}, cancelled ${asNumber(selectedUnitExecutionCounts?.cancelled)}${selectedUnitLabels.length > 0 ? ` — ${selectedUnitLabels.join(" | ")}` : ""}`
      : null;
  const missionPlanRulesLine =
    missionPlan?.available === true && Number(missionPlan.ruleRefCount ?? 0) > 0
      ? `- Mission rules: ${Number(missionPlan.ruleRefCount ?? 0)} refs${missionPlanRuleNames.length > 0 ? ` — ${missionPlanRuleNames.join(", ")}` : ""}${missionPlanRuleModes.length > 0 ? ` (${missionPlanRuleModes.join(", ")})` : ""}`
      : null;
  const missionWorkingNotePath = asString(missionWorkingNote?.path);
  const missionWorkingNoteLine =
    missionWorkingNote?.available === true && missionWorkingNotePath
      ? `- Mission working note: ${missionWorkingNotePath} (shared scratch context; read before acting, update mission status/evidence/decisions/next steps, not a final workProduct).`
      : null;
  const missionOwnerPlanningContextLine = buildMissionOwnerPlanningProtocol(missionOwnerPlanningContext);

  const guardrailLine =
    guardrails?.broadScanAllowed === true
      ? "- Broad scans: repo scope allowed by server policy; prefer missionSearch for structured discovery."
      : guardrails?.broadScanAllowed === false
        ? `- Broad scans: disallowed (allowed mission search scopes: ${missionSearchScopes.length > 0 ? missionSearchScopes.join(", ") : "none"}). Use missionSearch instead of pathless rg/find.`
        : null;
  const missionSearchPointer = missionSearchScopes.length > 0
    ? joinPromptSections([
        "Mission Search (server-side scoped discovery — use BEFORE any raw scan):",
        `- Available scopes this run: ${missionSearchScopes.join(", ")}.`,
        `- Canonical request, auth, and scope rules live in the Paperclip runtime skill (missionSearch); do not hand-roll a competing curl recipe here.`,
      ])
    : null;
  const issueExecutionCardLines = issueExecutionCard
    ? buildIssueExecutionCardBriefLines({
      card: context.paperclipIssueExecutionCard,
      cardHash: asString(context.paperclipIssueExecutionCardHash),
    })
    : [];
  const instructionInjectionLine = asString(instructionInjection?.mode)
    ? `- Agent instructions injection: ${asString(instructionInjection?.mode)}${asString(instructionInjection?.contentHash) ? ` (${asString(instructionInjection?.contentHash)})` : ""}.`
    : null;
  const userFacingLanguageLine = userFacingLanguage
    ? `- User-facing language: write issue descriptions, comments, and operator-facing summaries in ${userFacingLanguage}. Keep tool calls, code, identifiers, JSON, and other machine-facing control-plane data in English.`
    : null;

  const handoffSummary = handoff
    ? joinPromptSections([
        `- Previous session: ${asString(handoff.previousSessionId) ?? "unknown"}`,
        asString(handoff.rotationReason) ? `- Rotation reason: ${asString(handoff.rotationReason)}` : null,
        asString(handoff.lastRunSummaryText) ? `- Last run summary: ${asString(handoff.lastRunSummaryText)}` : null,
      ], "\n")
    : summarizeMarkdownHandoff(asString(context.paperclipSessionHandoffMarkdown))
      ? `- Previous handoff summary: ${summarizeMarkdownHandoff(asString(context.paperclipSessionHandoffMarkdown))}`
      : null;

  const brief = joinPromptSections([
    taskKey || issueId || projectId || allowedKeys.length > 0 || handoffSummary
      ? "Paperclip runtime brief:"
      : null,
    // [QA rework] rework 모드면 최우선 블록을 brief 선두에 배치(긴 runtime/issue 컨텍스트보다 먼저).
    ...reworkHeaderLines,
    ...runawayRecoveryLines,
    // [operator decision delivery] reworkHeader/runawayRecovery 뒤 상단 우선 블록 — 오너 카드 해결 지시.
    ...buildOperatorDecisionResolutionBriefLines(context.paperclipOperatorDecisionResolution),
    ...noProgressRecoveryLines,
    missionSearchPointer,
    userFacingLanguageLine,
    taskKey ? `- Task key: ${taskKey}` : null,
    issueId ? `- Issue: ${issueId}` : null,
    projectId ? `- Project: ${projectId}` : null,
    allowedKeys.length > 0 ? `- Allowed context keys: ${allowedKeys.join(", ")}` : null,
    workspaceLine,
    runtimeServicesLine,
    toolsLine,
    knowledgeLine,
    maintenanceGuidanceLine,
    maintenanceRuleLine,
    maintenanceRuleExcerptLine,
    maintenanceKnowledgeLine,
    maintenanceKnowledgeExcerptLine,
    maintenanceDecisionLine,
    maintenanceDecisionRequiredInputsLine,
    maintenanceDecisionWarningsLine,
    maintenanceDecisionHandoffLine,
    maintenanceRoleContextLine,
    maintenanceRoleQuestionsLine,
    missionPlanLine,
    missionPlanInputsLine,
    missionPlanStepsLine,
    missionPlanExecutionUnitsLine,
    missionPlanSelectedUnitsLine,
    missionPlanRulesLine,
    missionWorkingNoteLine,
    missionOwnerPlanningContextLine,
    ...workflowReworkContractLines,
    ...qaCapAcceptanceLines,
    workflowToolContractLine,
    recentIssueCommentsLine,
    hermesChatLine,
    fileViewsLine,
    guardrailLine,
    ...issueExecutionCardLines,
    instructionInjectionLine,
    handoffSummary,
  ], "\n");

  return brief;
}
