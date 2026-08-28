import {
  ALLOWED_URL_HOSTS,
  WORKFLOW_CATEGORY_MAP,
  type WorkflowKey,
} from "./constants.js";

export type ValidatedPublishRequest = {
  url: string;
  workflow: WorkflowKey | null;
  category: string;
};

export type ValidationResult =
  | { ok: true; request: ValidatedPublishRequest }
  | { ok: false; error: string };

const ALLOWED_HOST_SET = new Set<string>(ALLOWED_URL_HOSTS);
const WORKFLOW_KEYS = Object.keys(WORKFLOW_CATEGORY_MAP) as WorkflowKey[];
const CATEGORY_VALUES = [...new Set<string>(Object.values(WORKFLOW_CATEGORY_MAP))];

export function workflowKeys(): WorkflowKey[] {
  return [...WORKFLOW_KEYS];
}

export function allowedCategories(): string[] {
  return [...CATEGORY_VALUES];
}

export function categoryForWorkflow(workflow: string): string | null {
  const matched = WORKFLOW_CATEGORY_MAP[workflow.trim() as WorkflowKey];
  return typeof matched === "string" ? matched : null;
}

export function isAllowedCategory(category: string): boolean {
  return CATEGORY_VALUES.includes(category.trim());
}

export function validatePublishUrl(rawUrl: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false, error: "url은(는) 필수 문자열입니다." };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: `url을 파싱할 수 없습니다: ${rawUrl.trim()}` };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "url은 https 여야 합니다." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "url에 자격증명(username/password)을 포함할 수 없습니다." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOST_SET.has(hostname)) {
    return {
      ok: false,
      error: `허용되지 않은 호스트입니다: ${hostname} (허용: ${[...ALLOWED_HOST_SET].join(", ")})`,
    };
  }

  return { ok: true, url: parsed.toString() };
}

export function validatePublishRequest(input: {
  url?: unknown;
  workflow?: unknown;
  category?: unknown;
}): ValidationResult {
  const workflowRaw = typeof input.workflow === "string" ? input.workflow.trim() : "";
  const categoryRaw = typeof input.category === "string" ? input.category.trim() : "";

  if (workflowRaw && categoryRaw) {
    return { ok: false, error: "workflow와 category 중 하나만 지정해야 합니다." };
  }

  if (!workflowRaw && !categoryRaw) {
    return { ok: false, error: "workflow 또는 category 중 하나를 지정해야 합니다." };
  }

  if (workflowRaw) {
    const category = categoryForWorkflow(workflowRaw);
    if (!category) {
      return {
        ok: false,
        error: `알 수 없는 workflow입니다: ${workflowRaw} (허용: ${WORKFLOW_KEYS.join(", ")})`,
      };
    }

    const urlCheck = validatePublishUrl(input.url);
    if (!urlCheck.ok) {
      return { ok: false, error: urlCheck.error };
    }

    return {
      ok: true,
      request: { url: urlCheck.url, workflow: workflowRaw as WorkflowKey, category },
    };
  }

  if (!isAllowedCategory(categoryRaw)) {
    return {
      ok: false,
      error: `허용되지 않은 category입니다: ${categoryRaw} (허용: ${CATEGORY_VALUES.join(", ")})`,
    };
  }

  const urlCheck = validatePublishUrl(input.url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error };
  }

  return {
    ok: true,
    request: { url: urlCheck.url, workflow: null, category: categoryRaw },
  };
}

/**
 * Builds the JSON body forwarded to the mac bridge. The bridge accepts either
 * `workflow` or `category`; we pass through whichever the caller chose instead
 * of rewriting to category, keeping the proxy byte-faithful to the protocol.
 */
export function buildBridgePayload(request: ValidatedPublishRequest): Record<string, string> {
  if (request.workflow) {
    return { url: request.url, workflow: request.workflow };
  }

  return { url: request.url, category: request.category };
}
