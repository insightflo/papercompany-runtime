import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { findServerAdapter } from "../adapters/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { hermesChatService } from "../services/hermes-chat.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 8) return [];
    return value.slice(0, 50).map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 8) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 120)
        .map(([key, entry]) => [key.slice(0, 80), sanitizeJsonValue(entry, depth + 1)]),
    );
  }
  return undefined;
}

function sanitizePageContext(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sanitized = sanitizeJsonValue(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : null;
}

function sanitizeChatAttachments(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .slice(0, 6)
    .map((entry, index) => {
      const contentType = asString(entry.contentType) ?? asString(entry.mimeType) ?? "application/octet-stream";
      const kind = asString(entry.kind) ?? (contentType.startsWith("image/") ? "image" : "file");
      return {
        id: asString(entry.id) ?? `attachment-${index + 1}`,
        name: asString(entry.name) ?? asString(entry.fileName) ?? `attachment-${index + 1}`,
        contentType,
        size: typeof entry.size === "number" && Number.isFinite(entry.size) ? Math.max(0, entry.size) : 0,
        kind: kind === "image" ? "image" : "file",
        dataUrl: typeof entry.dataUrl === "string" ? entry.dataUrl.slice(0, 8_000_000) : undefined,
        text: typeof entry.text === "string" ? entry.text.slice(0, 100_000) : undefined,
      };
    });
}

function failedHermesEnvironmentResult(message: string, detail?: string): AdapterEnvironmentTestResult {
  return {
    adapterType: "hermes_local",
    status: "fail",
    checks: [{
      code: "hermes_environment_unavailable",
      level: "error",
      message,
      detail,
      hint: "Install and configure Hermes Agent before creating a Hermes Ops agent.",
    }],
    testedAt: new Date().toISOString(),
  };
}

export function hermesChatRoutes(db: Db) {
  const router = Router();
  const service = hermesChatService(db);
  const heartbeat = heartbeatService(db);
  const secrets = secretService(db);

  async function testHermesEnvironment(companyId: string): Promise<AdapterEnvironmentTestResult> {
    const adapter = findServerAdapter("hermes_local");
    if (!adapter?.testEnvironment) {
      return failedHermesEnvironmentResult("Hermes local adapter environment test is not available");
    }

    const agent = await service.findOperationsAgent(companyId);
    const adapterConfig = (agent?.adapterConfig ?? {}) as Record<string, unknown>;
    try {
      const { config } = await secrets.resolveAdapterConfigForRuntime(companyId, adapterConfig);
      return await adapter.testEnvironment({
        companyId,
        adapterType: "hermes_local",
        config,
      });
    } catch (err) {
      return failedHermesEnvironmentResult(
        "Hermes local environment could not be checked",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  router.get("/companies/:companyId/hermes-chat/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await service.listSessions(companyId));
  });

  router.get("/companies/:companyId/hermes-chat/operations-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const agent = await service.findOperationsAgent(companyId);
    const environment = await testHermesEnvironment(companyId);
    res.json({
      configured: !!agent,
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            adapterType: agent.adapterType,
            autoProvisionedNow: false,
          }
        : null,
      environment,
    });
  });

  router.post("/companies/:companyId/hermes-chat/operations-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const environment = await testHermesEnvironment(companyId);
    if (environment.status === "fail") {
      res.status(409).json({
        error: "Hermes local environment is not ready",
        environment,
      });
      return;
    }
    const agent = await service.ensureOperationsAgent(companyId);
    if (agent.autoProvisionedNow) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "hermes_chat.operations_agent_created",
        entityType: "agent",
        entityId: agent.id,
        details: {
          name: agent.name,
          adapterType: agent.adapterType,
          purpose: "hermes-operations-management",
        },
      });
    }
    res.json({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      adapterType: agent.adapterType,
      autoProvisionedNow: agent.autoProvisionedNow,
    });
  });

  router.post("/companies/:companyId/hermes-chat/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const session = await service.createSession(companyId, {
      title: asString(req.body?.title),
      createdByUserId: actor.actorId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "hermes_chat.session_created",
      entityType: "hermes_chat_session",
      entityId: session.id,
      details: { title: session.title },
    });
    res.status(201).json(session);
  });

  router.get("/companies/:companyId/hermes-chat/sessions/:sessionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sessionId = req.params.sessionId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const detail = await service.getSession(companyId, sessionId);
    if (!detail) {
      res.status(404).json({ error: "Hermes chat session not found" });
      return;
    }
    res.json(detail);
  });

  router.patch("/companies/:companyId/hermes-chat/sessions/:sessionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sessionId = req.params.sessionId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const status = asString(req.body?.status);
    if (status && !["active", "archived"].includes(status)) {
      res.status(422).json({ error: "status must be active or archived" });
      return;
    }
    const session = await service.updateSession(companyId, sessionId, {
      title: req.body?.title === undefined ? undefined : asString(req.body.title),
      status: status === null ? undefined : status as "active" | "archived",
    });
    if (!session) {
      res.status(404).json({ error: "Hermes chat session not found" });
      return;
    }
    res.json(session);
  });

  router.post("/companies/:companyId/hermes-chat/sessions/:sessionId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const sessionId = req.params.sessionId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const attachments = sanitizeChatAttachments(req.body?.attachments);
    const body = asString(req.body?.body) ?? (attachments.length > 0 ? "첨부 파일을 확인해줘." : null);
    if (!body) {
      res.status(422).json({ error: "Message body is required" });
      return;
    }

    const detail = await service.getSession(companyId, sessionId);
    if (!detail) {
      res.status(404).json({ error: "Hermes chat session not found" });
      return;
    }
    if (detail.session.status !== "active") {
      res.status(409).json({ error: "Cannot send messages to an archived Hermes chat session" });
      return;
    }

    const agent = await service.findOperationsAgent(companyId);
    if (!agent) {
      res.status(422).json({ error: "Hermes Operations Manager is not configured for this company" });
      return;
    }

    const userMessage = await service.addUserMessage(
      companyId,
      sessionId,
      body,
      attachments.length > 0 ? { attachments } : null,
    );
    const assistantMessage = await service.addAssistantPlaceholder(companyId, sessionId, agent.id);
    const recentMessages = await service.recentConversation(companyId, sessionId, 14);
    const actor = getActorInfo(req);
    const currentPage = sanitizePageContext(req.body?.pageContext);

    const run = await heartbeat.wakeup(agent.id, {
      source: "on_demand",
      triggerDetail: "hermes_web_chat",
      reason: "hermes_web_chat_message",
      payload: {
        sessionId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      },
      idempotencyKey: `hermes-chat:${companyId}:${userMessage.id}`,
      requestedByActorType: "user",
      requestedByActorId: actor.actorId,
      contextSnapshot: {
        taskKey: `hermes-chat:${sessionId}`,
        forceFreshSession: req.body?.forceFreshSession === true,
        paperclipHermesChat: {
          sessionId,
          sessionTitle: detail.session.title,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          currentMessage: body,
          recentMessages,
          currentPage,
          attachments,
          source: "paperclip_ui",
          instructions: [
            "Default to a concise operations answer for the sidebar: 3-6 short bullets or 1-2 short paragraphs, usually under 1200 Korean characters.",
            "Do not dump every issue/comment/run unless the operator asks for details, full evidence, or a report-style answer.",
            "This is a free-form operations chat, not a mission or issue assignment.",
            "Use live Paperclip state when answering questions about prior work, artifacts, agents, missions, workflow runs, or issue status.",
            "For status questions, lead with the current conclusion, then include only the 2-4 most important evidence points such as issue ids, run status, or work product counts.",
            "For mission/QA/failure questions, answer in this order: current state, short reason, key evidence, and next action.",
            "For blocked/failed/QA/artifact questions about a selected issue, do not answer from page summary alone. Use selected issue comments, workProducts, and run ids first; if those details are missing, say exactly which evidence is missing before concluding.",
            "If the operator asks for more detail, expand with issue identifiers, statuses, latest comments, runs, and work product counts.",
            "Do not mark issues or missions complete unless the operator explicitly asks you to perform that action and evidence is available.",
          ],
        },
      },
    });

    if (!run) {
      const failedAssistant = await service.markAssistantMessage(assistantMessage.id, {
        status: "failed",
        body: "Hermes is busy and this message was saved, but no run was queued.",
      });
      res.status(202).json({
        session: (await service.getSession(companyId, sessionId))?.session ?? detail.session,
        userMessage,
        assistantMessage: failedAssistant,
        runId: null,
      });
      return;
    }

    await service.attachRunToAssistantMessage(assistantMessage.id, run.id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: run.id,
      action: "hermes_chat.message_sent",
      entityType: "hermes_chat_session",
      entityId: sessionId,
      details: { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, agentId: agent.id },
    });

    res.status(202).json({
      session: (await service.getSession(companyId, sessionId))?.session ?? detail.session,
      userMessage,
      assistantMessage: { ...assistantMessage, status: "running", runId: run.id },
      runId: run.id,
    });
  });

  return router;
}
