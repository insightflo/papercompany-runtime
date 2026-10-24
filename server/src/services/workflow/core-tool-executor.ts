import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { executeAgentArtifactTool } from './agent-artifact-tool.js';
import { captureToolCallProvenance, recordToolCallProvenance, type ToolCallProvenance } from "./tool-call-provenance.js";
import { prepareQaConsumer } from "./qa-artifact-consumer.js";
import { verifyPublicationResult } from "./publication-result.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { executeQaByteTool } from "./qa-byte-transport.js";
import { writeArtifactFile } from "./artifact-writer.js";
import { loadArtifactAttempt, type FrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { captureQaDispatch } from "./qa-dispatch-guard.js";
import { prepareQaArtifactRequest } from "./qa-artifact-request.js";
import { QaArtifactRejectionError, toolDeploymentHashes, verifyQaArtifact } from "./qa-artifact-receipt.js";
import type { ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, toolDefinitions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { executeRemoteWorkflowTool, type CoreWorkflowToolRemoteDeps } from "./remote-tool-executor.js";
import { resolveWorkflowRunStepOutputDir } from "./remote-tool-context.js";
import { normalizeCommandParts, parametersToCliArgs, readObject } from "./core-tool-context.js";
import { readToolProgressPolicy, ToolProgressError } from "../tools/progress-policy.js";
import { executeLocalToolWithProgress } from "./local-tool-progress-executor.js";
import type { ProgressEvidenceContext } from "../tools/progress-store.js";
import { executeAgentJudgmentTool } from "../judgment/agent-judgment-tool-executor.js";
import { executeMissionOwnerAction, OwnerActionRefusalError, withCurrentOwnerToolAttempt } from "../missions/mission-owner-execute.js";
import { missionOwnerExecuteSchema } from "@paperclipai/shared/validators/mission-owner-authority";
import { executeHtmlPreflightTool } from "../judgment/html-preflight-executor.js";
import { secretService } from "../secrets.js";
import type { JudgmentService } from "../judgment/judgment-service.js";
export { parametersToCliArgs, resolveRunStepEnv, resolveWorkflowRunStepEnv } from "./core-tool-context.js";

const execFile = promisify(execFileCallback);
export type CoreWorkflowToolExecutionResult = {
  status: 200 | 403 | 404 | 409 | 422 | 500 | 501 | 503;
  artifactPath?: string;
  toolArtifactReceipt?: ToolArtifactReceipt;
  body: { content?: string; data?: unknown; stderr?: string; tool?: string; source?: "core"; error?: string; invocationProvenance?: ToolCallProvenance | null };
};
export async function checkCoreWorkflowToolsAvailable(db: Db, input: { companyId: string; toolNames: string[] }): Promise<
  { available: true } | { available: false; reason: string }
> {
  const requested = Array.from(new Set(input.toolNames.map((name) => name.trim()).filter(Boolean)));
  if (requested.length === 0) return { available: true };
  const rows = await db.select({ name: toolDefinitions.name, enabled: toolDefinitions.enabled }).from(toolDefinitions)
    .where(eq(toolDefinitions.companyId, input.companyId));
  const byName = new Map(rows.map((row) => [row.name, row]));
  const missing = requested.find((name) => !byName.has(name));
  if (missing) return { available: false, reason: `Core workflow tool "${missing}" is not registered.` };
  const disabled = requested.find((name) => byName.get(name)?.enabled === false);
  if (disabled) return { available: false, reason: `Core workflow tool "${disabled}" is disabled.` };
  return { available: true };
}
export async function executeCoreWorkflowTool(input: {
  db: Db; companyId: string; agentId?: string | null; agentName?: string | null; issueId?: string | null;
  toolName: string; parameters: unknown; requestId: string; workflowRunId?: string | null; stepRunId?: string | null; stepId?: string | null;
  stepEnv?: Record<string, string>; remoteDeps?: CoreWorkflowToolRemoteDeps; judgmentService?: JudgmentService;
  /** Authenticated server route only; never taken from tool parameters. */
  heartbeatRunId?: string;
  /** Attribution context only; never an additional execution authorization gate. */
  progressEvidenceContext?: ProgressEvidenceContext;
  artifactDispatch?: Awaited<ReturnType<typeof captureQaDispatch>>;
}): Promise<CoreWorkflowToolExecutionResult> {
  const [tool] = await input.db.select({ id: toolDefinitions.id, name: toolDefinitions.name,
    enabled: toolDefinitions.enabled, adapterType: toolDefinitions.adapterType, adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions).where(and(eq(toolDefinitions.companyId, input.companyId), eq(toolDefinitions.name, input.toolName))).limit(1);
  if (!tool) return { status: 404, body: { error: `Tool "${input.toolName}" not found` } };
  if (!tool.enabled) return { status: 403, body: { error: `Tool "${input.toolName}" is disabled` } };
  const adapterConfig = readObject(tool.adapterConfig);
  const isJudgmentTool = tool.adapterType === "builtin" && adapterConfig.kind === "judgment";
  const isHtmlPreflightTool = tool.adapterType === "builtin" && adapterConfig.kind === "html-preflight";
  let agentId = input.agentId?.trim() || "";
  if (!agentId && input.agentName?.trim()) {
    const [agent] = await input.db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.name, input.agentName.trim()))).limit(1);
    agentId = agent?.id ?? "";
  }
  const hasWorkflowStepContext = Boolean(input.workflowRunId?.trim() && input.stepId?.trim());
  if ((isJudgmentTool || isHtmlPreflightTool) && !agentId && !hasWorkflowStepContext) {
    return { status: 403, body: { error: `Agent identity is required for workflow tool "${input.toolName}"` } };
  }
  if (agentId) {
    const [grant] = await input.db.select({ id: agentToolGrants.id }).from(agentToolGrants).where(and(
      eq(agentToolGrants.companyId, input.companyId), eq(agentToolGrants.agentId, agentId), eq(agentToolGrants.toolId, tool.id),
    )).limit(1);
    if (!grant) return { status: 403, body: { error: `Agent is not granted workflow tool "${input.toolName}"` } };
  }
  if (tool.adapterType === "builtin" && adapterConfig.kind === "mission-owner-execute") {
    // Actor/heartbeat come from the authenticated server route, never tool parameters.
    const parsed = missionOwnerExecuteSchema.safeParse(input.parameters);
    if (!parsed.success) return { status: 422, body: { error: "invalid_mission_owner_execute_request", tool: input.toolName, source: "core" } };
    if (!input.agentId?.trim() || !input.heartbeatRunId?.trim()) {
      return { status: 403, body: { error: "owner_identity_required", tool: input.toolName, source: "core" } };
    }
    try {
      const result = await executeMissionOwnerAction({ db: input.db, companyId: input.companyId,
        agentId: input.agentId.trim(), heartbeatRunId: input.heartbeatRunId.trim() }, parsed.data);
      return { status: 200, body: { content: JSON.stringify(result), data: result, tool: input.toolName, source: "core" } };
    } catch (error) {
      if (error instanceof OwnerActionRefusalError) {
        return { status: error.status, body: { error: error.reasonCode, tool: input.toolName, source: "core" } };
      }
      throw error;
    }
  }
  if (input.heartbeatRunId && adapterConfig.artifactContract !== undefined) {
    return executeAgentArtifactTool(input, executeCoreWorkflowTool);
  }
  let artifactExecution: FrozenArtifactAttempt | null;
  try { artifactExecution = await loadArtifactAttempt({ ...input, adapterConfig }); }
  catch (error) { return { status: 422, body: { error: (error as Error).message, source: "core", tool: input.toolName } }; }
  if (artifactExecution && (tool.adapterType !== "builtin" || isJudgmentTool || isHtmlPreflightTool)) {
    return { status: 422, body: { error: "artifact_contract_adapter_unsupported", source: "core", tool: input.toolName } };
  }
  if (isJudgmentTool || isHtmlPreflightTool) {
    // [봇 bug·medium 교정] 디렉토리 해석 실패(일시 DB 오류 포함)가 관측 도구 실행 자체를
    //   실패시키지 않게 한다 — 결과는 각 실행기가 구조화해 반환한다.
    let stepOutputDir: string | null = null;
    if (hasWorkflowStepContext) {
      try {
        stepOutputDir = await resolveWorkflowRunStepOutputDir(input.db, {
          companyId: input.companyId,
          workflowRunId: input.workflowRunId,
          stepId: input.stepId,
        });
      } catch {
        stepOutputDir = null;
      }
    }
    const sharedInput = {
      db: input.db,
      companyId: input.companyId,
      toolName: input.toolName,
      parameters: input.parameters,
      requestId: input.requestId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      stepOutputDir,
    };
    if (isJudgmentTool) return executeAgentJudgmentTool({ ...sharedInput, judgmentService: input.judgmentService });
    return executeHtmlPreflightTool(sharedInput);
  }
  const remoteResult = await executeRemoteWorkflowTool({ db: input.db, companyId: input.companyId,
    toolId: tool.id, toolName: input.toolName, parameters: input.parameters, requestId: input.requestId,
    workflowRunId: input.workflowRunId, stepId: input.stepId, adapterType: tool.adapterType,
    adapterConfig: tool.adapterConfig, remoteDeps: input.remoteDeps });
  if (remoteResult) return remoteResult;
  if (tool.adapterType !== "builtin") return { status: 501,
    body: { error: `Core workflow tool "${input.toolName}" uses unsupported adapter type "${tool.adapterType}"` } };
  const command = typeof adapterConfig.command === "string" ? adapterConfig.command.trim() : "";
  const commandParts = normalizeCommandParts(command);
  if (commandParts.length === 0) return { status: 422, body: { error: `Core workflow tool "${input.toolName}" has no command configured` } };
  if (adapterConfig.requiresApproval === true) return { status: 403, body: { error: `Core workflow tool "${input.toolName}" requires approval` } };
  const cwd = typeof adapterConfig.workingDirectory === "string" && adapterConfig.workingDirectory.trim()
    ? adapterConfig.workingDirectory.trim() : process.cwd();
  const envConfig = readObject(adapterConfig.env);
  const resolvedEnv: Record<string, string> = {};
  const secrets = secretService(input.db);
  for (const [key, binding] of Object.entries(envConfig)) {
    try {
      const resolved = await secrets.resolveEnvBindings(input.companyId, { [key]: binding });
      Object.assign(resolvedEnv, resolved.env);
    } catch {
      return { status: 422, body: { error: `Unable to resolve environment binding for key: ${key}`,
        tool: input.toolName, source: "core" } };
    }
  }
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.PAPERCLIP_SECRETS_MASTER_KEY;
  delete inheritedEnv.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const timeoutMs = typeof adapterConfig.timeoutMs === "number" && Number.isFinite(adapterConfig.timeoutMs)
    ? Math.max(1, Math.trunc(adapterConfig.timeoutMs)) : 120_000;
  let executable = commandParts[0]!;
  let invocationProvenance: ToolCallProvenance | null = null;
  try {
    // Fence the attempt before any awaited deployment/input byte reads.
    const initialDispatch = artifactExecution ? input.artifactDispatch ?? await captureQaDispatch(input) : undefined;
    await initialDispatch?.assertCurrent();
    const qaRequest = await prepareQaArtifactRequest({ ...input, artifactExecution, dispatch: initialDispatch });
    const deploymentFiles = artifactExecution?.contract.deploymentFiles;
    const deployment = deploymentFiles ? await toolDeploymentHashes(deploymentFiles, cwd) : null;
    const prepared = qaRequest ?? await prepareQaConsumer({ ...input, artifactExecution, dispatch: initialDispatch });
    const dispatch = prepared.dispatch;
    const allArgs = [...commandParts.slice(1), ...parametersToCliArgs(prepared.parameters)];
    const consumerRoot = "resultRoot" in prepared ? prepared.resultRoot : undefined;
    const publicationScope = "publicationScope" in prepared ? prepared.publicationScope : undefined;
    const policy = readToolProgressPolicy(adapterConfig);
    const env: NodeJS.ProcessEnv = { ...inheritedEnv, ...resolvedEnv,
      PAPERCLIP_COMPANY_ID: input.companyId,
      ...(agentId ? { PAPERCLIP_AGENT_ID: agentId } : {}),
      ...(input.issueId ? { PAPERCLIP_TASK_ID: input.issueId } : {}), ...(input.stepEnv ?? {}),
      ...(qaRequest ? { PAPERCLIP_STEP_OUTPUT_DIR: qaRequest.snapshot.outputRoot,
        PAPERCLIP_WORKFLOW_STEP_ID: qaRequest.snapshot.stepId, PAPERCLIP_EXECUTION_GENERATION: String(qaRequest.snapshot.executionGeneration),
        PAPERCLIP_REQUEST_ID: input.requestId } : {}),
      PAPERCOMPANY_ARTIFACT_INPUT: prepared.inputBytes ? "stdin-v1" : undefined,
      PAPERCOMPANY_ARTIFACT_INPUT_VERSION: artifactExecution?.contract.inputEnvelopeVersion,
      PAPERCOMPANY_ARTIFACT_RESULT_FD: qaRequest || consumerRoot ? "4" : undefined,
      PAPERCOMPANY_ARTIFACT_RESULT_SCHEMA: artifactExecution?.contract.resultSchemaVersion,
      PAPERCOMPANY_ARTIFACT_CONTRACT: artifactExecution ? JSON.stringify(artifactExecution.contract) : undefined,
      PAPERCOMPANY_ARTIFACT_SCOPE: publicationScope ? JSON.stringify(publicationScope) : undefined,
      PAPERCOMPANY_QA_INPUT: prepared.inputBytes ? "stdin-v1" : undefined,
      PAPERCOMPANY_QA_RESULT_FD: qaRequest || consumerRoot ? "4" : undefined,
      PAPERCOMPANY_PUBLICATION_SCOPE: publicationScope ? JSON.stringify(publicationScope) : undefined,
      ...(consumerRoot ? { PAPERCLIP_STEP_OUTPUT_DIR: consumerRoot.path } : {}),
    };
    invocationProvenance = await captureToolCallProvenance({ ...input, toolId: tool.id, commandParts, cwd, env, deploymentFiles });
    if (invocationProvenance?.executable.sha256) executable = invocationProvenance.executable.path;
    // Only a deployed JS entrypoint on this known Node binary, without preceding
    // options/preloads, can opt into guarded exit-one. Other calls keep exit-zero.
    const node = invocationProvenance?.core;
    const entrypoint = qaRequest && commandParts[1] && !commandParts[1].startsWith("-")
      ? await realpath(path.resolve(cwd, commandParts[1])).catch(() => null) : null;
    const nodeFile = node?.files.find(file => file.path === node.executablePath);
    const acceptQaExit1 = !!(qaRequest && artifactExecution?.contract.role === "qa" && deployment?.length
      && node?.nodeVersion.startsWith("v24.") && !env.NODE_OPTIONS?.trim()
      && invocationProvenance?.executable.path === node.executablePath && nodeFile?.sha256
      && invocationProvenance.executable.sha256 === nodeFile.sha256
      && invocationProvenance.interpreter.path === invocationProvenance.executable.path
      && invocationProvenance.interpreter.sha256 === nodeFile.sha256
      && entrypoint && /\.(mjs|cjs|js)$/.test(entrypoint)
      && invocationProvenance.toolFiles.some(file => file.path === entrypoint && file.sha256)
      && deploymentFiles?.every((file, index) => {
        const observed = invocationProvenance?.toolFiles[index], pinned = deployment.find(item => item.fileName === file);
        return !!pinned && !!observed?.sha256 && observed.sha256 === pinned.sha256 && observed.byteSize === pinned.byteSize;
      }));
    await recordToolCallProvenance(input.db, invocationProvenance, "prepared");
    // Fence owner-execute-linked attempts right before the real child process launch;
    // unrelated tools pass through with existing behavior.
    const invocation = () => withCurrentOwnerToolAttempt<{ stdout: string; stderr: string; qaResultBytes?: Buffer; exitCode?: number }>(
      { db: input.db, companyId: input.companyId, requestId: input.requestId,
        workflowRunId: input.workflowRunId ?? null, stepRunId: input.stepRunId ?? null },
      () => policy
      ? executeLocalToolWithProgress({ db: input.db, scope: { companyId: input.companyId, toolId: tool.id,
          requestId: input.requestId, adapterType: "builtin", workflowRunId: input.workflowRunId, stepId: input.stepId },
        progressEvidenceContext: input.progressEvidenceContext, agentId, stepRunId: input.stepRunId,
        policy, executable, args: allArgs, cwd, env, launch: dispatch?.launch, inputBytes: prepared.inputBytes, qaResult: !!(qaRequest || consumerRoot), acceptQaExit1 })
      : prepared.inputBytes ? executeQaByteTool({ executable, args: allArgs, cwd, env, inputBytes: prepared.inputBytes, qaResult: !!(qaRequest || consumerRoot), acceptQaExit1, timeoutMs })
      : execFile(executable, allArgs, { cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }));
    const result = await (dispatch && !policy ? (await dispatch.launch(invocation)).result : invocation());
    await recordToolCallProvenance(input.db, invocationProvenance, "returned");
    const { stdout, stderr } = result;
    if (qaRequest && deployment) {
      const bytes = "qaResultBytes" in result ? result.qaResultBytes : undefined;
      if (!bytes?.length) throw new Error("qa_result_transport_missing");
      await writeArtifactFile(qaRequest.snapshot.root, qaRequest.snapshot.artifactExecution.contract.resultFileName, bytes);
      if (JSON.stringify(deployment) !== JSON.stringify(await toolDeploymentHashes(deploymentFiles!, cwd))) throw new Error("qa_tool_deployment_changed");
      const exitCode = result.exitCode ?? 0;
      const exitFailure = () => Object.assign(new Error("qa_tool_failed"), { code: exitCode, stdout, stderr });
      const verified = await verifyQaArtifact(qaRequest, tool, deployment).catch((error: unknown) => {
        if (exitCode !== 0) {
          // A positive plugin result with a failed process cannot become server-rule rework.
          if (error instanceof QaArtifactRejectionError && error.message !== "qa_artifact_verdict_failed") throw exitFailure();
          if (error instanceof Error) Object.assign(error, { exitCode, stdout, stderr });
        }
        throw error;
      });
      if (exitCode !== 0) throw exitFailure();
      return { status: 200, toolArtifactReceipt: verified.receipt,
        body: { content: stdout.trim(), stderr: stderr.trim(), data: { ...verified.qa, verdict: "pass" }, tool: input.toolName, source: "core", invocationProvenance } };
    }
    if (consumerRoot) {
      const bytes = "qaResultBytes" in result ? result.qaResultBytes : undefined;
      if (!publicationScope || !prepared.inputBytes) throw new Error("qa_publish_result_scope_missing");
      // idSourcePath is only honored inside this run's company-scoped work-product directory.
      const runPaths = await resolveMissionWorkProductPaths(input.db, { companyId: publicationScope.companyId,
        missionId: publicationScope.missionId, workflowRunId: publicationScope.workflowRunId });
      const verified = await verifyPublicationResult({ bytes, root: consumerRoot, scope: publicationScope,
        contract: artifactExecution!.contract, sourcePublication: 'sourcePublication' in prepared ? prepared.sourcePublication : undefined,
        inputBytes: prepared.inputBytes, parameters: readObject(prepared.parameters), runOutputDir: runPaths?.runOutputDir });
      return { status: 200, artifactPath: verified.artifactPath,
        body: { content: stdout.trim(), stderr: stderr.trim(), data: verified, tool: input.toolName, source: "core", invocationProvenance } };
    }
    const trimmedStdout = stdout.trim();
    const trimmedStderr = stderr.trim();
    let parsed: unknown;
    if (trimmedStdout) {
      try { parsed = JSON.parse(trimmedStdout); } catch { parsed = undefined; }
    }
    return { status: 200, body: { content: trimmedStdout, data: parsed ?? { stdout: trimmedStdout },
      stderr: trimmedStderr, tool: input.toolName, source: "core", invocationProvenance } };
  } catch (error) {
    if (invocationProvenance?.phase === "prepared") await recordToolCallProvenance(input.db, invocationProvenance, "threw");
    const typed = error as Error & { code?: string | number; exitCode?: number; stdout?: unknown; stderr?: unknown };
    const stdout = typeof typed.stdout === "string" ? typed.stdout.trim() : "";
    const stderr = typeof typed.stderr === "string" ? typed.stderr.trim() : "";
    const code = typed.code === undefined ? "" : ` (exit: ${String(typed.code)})`;
    const status = (error instanceof ToolProgressError && error.status === 422) || typed.message.startsWith("artifact_contract_") ? 422 : 500;
    const message = adapterConfig.progress !== undefined && !(error instanceof ToolProgressError) && !(error instanceof QaArtifactRejectionError) && !typed.message.startsWith("artifact_contract_")
      ? "tool_progress_execution_failed" : typed.message;
    return { status, body: { error: `${message}${code}`, data: { stdout, ...(typed.exitCode === undefined ? {} : { exitCode: typed.exitCode }) }, stderr, tool: input.toolName, source: "core", invocationProvenance } };
  }
}
