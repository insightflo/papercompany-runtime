import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { logger } from "../../middleware/logger.js";
import { persistArtifact } from "../workflow/http-tool-response.js";
import type { Db } from "@paperclipai/db";
import type { CoreWorkflowToolExecutionResult } from "../workflow/core-tool-executor.js";

export const HTML_PREFLIGHT_SCOPE =
  "conservative structural HTML preflight; not an HTML validator";
const NEAR_EMPTY_TEXT_CHARS = 20;
const NON_VISIBLE_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const strictUtf8TextDecoder = new TextDecoder("utf-8", { fatal: true });

export type HtmlPreflightResult = {
  ok: boolean;
  findings: string[];
  stats: { docChars: number; textChars: number; nodeCount: number };
};

function defect(finding: string, docChars = 0): HtmlPreflightResult {
  return { ok: false, findings: [finding], stats: { docChars, textChars: 0, nodeCount: 0 } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visibleTextChars(body: HTMLElement | null): number {
  if (!body) return 0;
  let text = "";
  const pending: Node[] = [body];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!parent || !NON_VISIBLE_TAGS.has(parent.tagName)) text += node.nodeValue ?? "";
    }
    pending.push(...Array.from(node.childNodes));
  }
  return text.replace(/\s+/g, "").length;
}

function nodeCount(document: Document): number {
  let count = 0;
  const pending: Node[] = [document];
  while (pending.length > 0) {
    const node = pending.pop()!;
    count += 1;
    pending.push(...Array.from(node.childNodes));
  }
  return count;
}

export function inspectHtmlDocument(document: Document, docChars: number): HtmlPreflightResult {
  const findings: string[] = [];
  const root = document.documentElement;
  if (!root) findings.push("missing_document_element");
  else if (root.tagName !== "HTML") findings.push("non_html_document_element");
  if (!document.body) findings.push("missing_body");

  const textChars = visibleTextChars(document.body);
  if (textChars < NEAR_EMPTY_TEXT_CHARS) {
    findings.push(`near_empty_text_content: visibleTextChars=${textChars} (<${NEAR_EMPTY_TEXT_CHARS})`);
  }
  return {
    ok: findings.length === 0,
    findings,
    stats: { docChars, textChars, nodeCount: nodeCount(document) },
  };
}

async function readDocumentFile(
  filePath: string,
): Promise<{ document: string; docChars: number } | HtmlPreflightResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return defect("document_unreadable");
  }
  try {
    const document = strictUtf8TextDecoder.decode(bytes);
    return { document, docChars: document.length };
  } catch {
    return defect("artifact_type_mismatch: document is not decodable as UTF-8 text");
  }
}

async function parseInput(
  parameters: unknown,
  options: { allowDocumentPath: boolean },
): Promise<{ document: string; docChars: number } | HtmlPreflightResult> {
  if (!isPlainRecord(parameters)) return defect("input_type_mismatch: parameters must be an object");
  const rejected = Object.keys(parameters).filter((key) => key !== "document" && key !== "documentPath");
  if (rejected.length > 0) return defect("input_schema_mismatch: unknown fields " + rejected.sort().join(", "));

  const inlineDocument = parameters.document;
  const documentPath = parameters.documentPath;
  if (inlineDocument !== undefined && documentPath !== undefined) return defect("input_conflict: provide exactly one of document or documentPath");
  if (typeof inlineDocument === "string") return { document: inlineDocument, docChars: inlineDocument.length };
  if (inlineDocument !== undefined) return defect("input_type_mismatch: document must be a string");
  if (documentPath === undefined) return defect("input_missing: document or documentPath is required");
  if (!options.allowDocumentPath) return defect("document_path_requires_workflow_context");
  if (typeof documentPath !== "string" || documentPath.trim().length === 0) {
    return defect("input_type_mismatch: documentPath must be a non-empty string");
  }
  return readDocumentFile(documentPath);
}

export async function executeHtmlPreflightTool(input: {
  db: Db;
  companyId: string;
  toolName: string;
  parameters: unknown;
  requestId: string;
  workflowRunId?: string | null;
  stepRunId?: string | null;
  stepId?: string | null;
  stepOutputDir?: string | null;
}): Promise<CoreWorkflowToolExecutionResult> {
  void input.db;
  void input.companyId;
  const isWorkflowStepContext = Boolean(input.workflowRunId?.trim() && input.stepId?.trim());
  const parsed = await parseInput(input.parameters, { allowDocumentPath: isWorkflowStepContext });
  let result: HtmlPreflightResult;
  if ("document" in parsed) {
    try {
      result = inspectHtmlDocument(new JSDOM(parsed.document).window.document, parsed.docChars);
    } catch {
      result = defect("pathological_parse_result", parsed.docChars);
    }
  } else {
    result = parsed;
  }

  let artifactPath: string | undefined;
  if (isWorkflowStepContext && input.stepOutputDir) {
    try {
      artifactPath = await persistArtifact(input.stepOutputDir, "html-preflight-result.json", {
        ...result,
        scope: HTML_PREFLIGHT_SCOPE,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn(
        { err: (error as Error).message, workflowRunId: input.workflowRunId, stepId: input.stepId },
        "html-preflight artifact persistence failed — structured result returned without artifact",
      );
    }
  }

  const data = {
    ...result,
    scope: HTML_PREFLIGHT_SCOPE,
    ...(artifactPath ? { artifactPath } : {}),
  };
  return {
    ...(artifactPath ? { artifactPath } : {}),
    status: 200,
    body: {
      content: `html-preflight ok=${result.ok}; findings=${result.findings.length}; docChars=${result.stats.docChars}; textChars=${result.stats.textChars}; nodeCount=${result.stats.nodeCount}`,
      data,
      tool: input.toolName,
      source: "core" as const,
    },
  };
}
