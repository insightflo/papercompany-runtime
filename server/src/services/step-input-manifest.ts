import { parseObject } from "../adapters/utils.js";

export interface StepInputManifest {
  version: 1;
  taskKey: string | null;
  issueId: string | null;
  projectId: string | null;
  allowedContextKeys: string[];
  guardrails: {
    broadScanAllowed: boolean;
  };
  inputs: {
    workspace: {
      available: boolean;
      source: string | null;
      workspaceId: string | null;
      projectId: string | null;
    };
    workspaceHints: {
      available: boolean;
      count: number;
    };
    runtimeServiceIntents: {
      available: boolean;
      count: number;
    };
    runtimeServices: {
      available: boolean;
      count: number;
      primaryUrl: string | null;
    };
    tools: {
      available: boolean;
      count: number;
      names: string[];
    };
    knowledge: {
      available: boolean;
      count: number;
      names: string[];
    };
    fileViews: {
      available: boolean;
      count: number;
      source: string | null;
    };
    sessionHandoff: {
      available: boolean;
      previousSessionId: string | null;
      rotationReason: string | null;
    };
  };
}

export function buildStepInputManifest(input: {
  taskKey: string | null;
  context: Record<string, unknown>;
}): StepInputManifest {
  const { context, taskKey } = input;
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const toolContract = parseObject(context.paperclipWorkflowStepToolContract);
  const toolEntries = Array.isArray(toolContract.tools)
    ? toolContract.tools.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const knowledgeContract = parseObject(context.paperclipWorkflowStepKnowledgeContext);
  const knowledgeEntries = Array.isArray(knowledgeContract.entries)
    ? knowledgeContract.entries.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const fileViews = Array.isArray(context.paperclipFileViews)
    ? context.paperclipFileViews.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const allowedContextKeys = Object.keys(context)
    .filter((key) => key !== "paperclipStepInputManifest")
    .sort();

  const workspaceSource = readString(workspace.source) || null;
  const workspaceId = readString(workspace.workspaceId) || null;
  const workspaceProjectId = readString(workspace.projectId) || null;
  const hasProjectPrimaryWorkspace = workspaceSource === "project_primary" && workspaceId !== null;

  return {
    version: 1,
    taskKey,
    issueId: readString(context.issueId) || null,
    projectId: readString(context.projectId) || null,
    allowedContextKeys,
    guardrails: {
      broadScanAllowed: hasProjectPrimaryWorkspace,
    },
    inputs: {
      workspace: {
        available: Object.keys(workspace).length > 0,
        source: workspaceSource,
        workspaceId,
        projectId: workspaceProjectId,
      },
      workspaceHints: {
        available: workspaceHints.length > 0,
        count: workspaceHints.length,
      },
      runtimeServiceIntents: {
        available: runtimeServiceIntents.length > 0,
        count: runtimeServiceIntents.length,
      },
      runtimeServices: {
        available: runtimeServices.length > 0,
        count: runtimeServices.length,
        primaryUrl: readString(context.paperclipRuntimePrimaryUrl) || null,
      },
      tools: {
        available: toolEntries.length > 0,
        count: toolEntries.length,
        names: toolEntries
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
      },
      knowledge: {
        available: knowledgeEntries.length > 0,
        count: knowledgeEntries.length,
        names: knowledgeEntries
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
      },
      fileViews: {
        available: fileViews.length > 0,
        count: fileViews.length,
        source: readString(fileViews[0]?.source) || null,
      },
      sessionHandoff: {
        available: readString(context.paperclipSessionHandoffMarkdown).length > 0,
        previousSessionId: readString(context.paperclipPreviousSessionId) || null,
        rotationReason: readString(context.paperclipSessionRotationReason) || null,
      },
    },
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}
