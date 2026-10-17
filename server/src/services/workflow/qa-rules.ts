import { createHash } from "node:crypto";
import { artifactContractSchema, canonicalQaJson, resolveEffectiveQaConfig, selectArtifactValues,
  type ArtifactContract, type QaCheck, type QaConfig } from "@paperclipai/shared";
import { inspectQaDocument } from "./qa-rules-document.js";
import { qaLinksReachable } from "./qa-links-reachable.js";

export function hashQaConfig(config: QaConfig): string {
  return createHash("sha256").update(canonicalQaJson(resolveEffectiveQaConfig(undefined, config))).digest("hex");
}
export function hashArtifactContract(contract: ArtifactContract): string {
  return createHash("sha256").update(canonicalQaJson(artifactContractSchema.parse(contract))).digest("hex");
}
export interface QaRulesInput {
  config?: QaConfig;
  json?: unknown;
  html?: string;
  /** Runtime-owned absolute roots, including canonical real paths. Not document input. */
  internalPathRoots?: readonly string[];
  /** Set by runtime byte/provenance and machine-result validators, never by the plugin itself. */
  provenanceValid: boolean;
  resultValid: boolean;
  /** Runtime-verified uploaded asset digests, not a plugin claim. */
  assetManifest?: { fileName: string; sha256: string; byteSize: number }[];
}
export interface QaRulesResult { ok: boolean; checks: QaCheck[] }

/** Appends one runtime check; a FAILING check must carry a brief one-line detail. */
export function appendQaCheck(checks: QaCheck[], id: string, ok: boolean, detail?: string): void {
  // [fail-closed constructor — 2026-10-17] ok=false without a usable detail is a construction bug,
  // never a valid verdict: throw immediately (qa_check_detail_required) so a new check can never
  // fail silently detail-free. Brief + single-line matters downstream: the failure summary rides
  // `qa_artifact_runtime_checks_failed:<ids> <details>` whose whitelist regex has no dotall, and
  // the persisted summary/rework feedback is bounded. This runtime guard is the FINAL defense
  // line — call sites pass computed booleans, so overloads cannot express (ok=false ⇒ detail)
  // for them at compile time. The throw surfaces as an unmapped infra failure (P4), not a
  // silent content verdict — same philosophy as the qa_document_limit infra separation.
  if (!ok && (typeof detail !== "string" || detail.trim() === "" || /[\r\n]/.test(detail))) {
    throw new Error("qa_check_detail_required");
  }
  checks.push({ id, ok, severity: "error", ...(detail ? { detail } : {}) });
}

/** Runtime checks remain separate from plugin checks in the durable receipt. */
export async function evaluateQaRules(input: QaRulesInput): Promise<QaRulesResult> {
  const config = resolveEffectiveQaConfig(undefined, input.config);
  const checks: QaCheck[] = [];
  let document: ReturnType<typeof inspectQaDocument> | undefined;
  try { document = inspectQaDocument(input.json, input.html, input.internalPathRoots); }
  catch (error) {
    // [infra separation] Document inspection limits (size/depth/node budget) are infra/config
    // failures, not content-rule verdicts: the content was never inspected. Propagate the
    // qa_document_limit signature so verifyQaArtifact records it as-is — it does NOT match the
    // mechanical content-rejection whitelist, so the rework loop stays closed for it (P4 guard).
    if (error instanceof Error && error.message === "qa_document_limit") throw error;
    /* other limits fail closed below */
  }
  const add = (id: string, ok: boolean, detail?: string) => appendQaCheck(checks, id, ok, detail);
  const assets = input.assetManifest ?? [];
  // Inspection lost to a non-limit inspect error (fail-closed): document-derived checks fail
  // with a kind-only detail — no document text is echoed into summaries or rework feedback.
  const noDocument = "qa document unavailable";
  for (const [id, rule] of Object.entries(config.rules)) {
    if (!rule || rule.enabled === false) continue;
    switch (id) {
      case "provenance": add(id, input.provenanceValid === true,
        input.provenanceValid === true ? undefined : "provenance validation failed"); break;
      case "result-format": add(id, input.resultValid === true,
        input.resultValid === true ? undefined : "result format validation failed"); break;
      case "no-sensitive-data": {
        const ok = !!document && !document.sensitive;
        add(id, ok, ok ? undefined : document ? "sensitive data pattern matched" : noDocument);
        break;
      }
      case "no-external-script": {
        const ok = !!document && !document.externalScript;
        add(id, ok, ok ? undefined : document ? "external or active script element" : noDocument);
        break;
      }
      case "no-external-iframe": {
        const ok = !!document && !document.externalIframe;
        add(id, ok, ok ? undefined : document ? "iframe present" : noDocument);
        break;
      }
      case "https-links": {
        // Rejection detail carries the violating links (userinfo-stripped, bounded) so the
        // persisted dispatch summary and the rework feedback show WHAT violated, not just the id.
        const insecure = document?.insecureLinks ?? [];
        const ok = !!document && document.secureLinks;
        const detail = ok ? undefined : insecure.length > 0
          ? `insecure links: ${insecure.slice(0, 5).map(link => link.slice(0, 160)).join(" ")}${insecure.length > 5 ? " …" : ""}`
          : noDocument;
        add(id, ok, detail);
        break;
      }
      case "min-source-links": {
        const params = config.rules["min-source-links"]?.params;
        if (!params) { add(id, false, "qa_rule_params_required"); break; }
        const links = params.pointers ? selectArtifactValues(input.json, params.pointers).flatMap(v => Array.isArray(v) ? v : [v])
          .filter((v): v is string => typeof v === "string" && /^https:\/\//i.test(v)) : document?.sourceLinks ?? [];
        const actual = new Set(links).size, ok = actual >= params.min;
        add(id, ok, ok ? undefined : `${actual}/${params.min} https source links`);
        break;
      }
      case "links-reachable": break; // Network follows all local safety checks below.
      case "uploaded-asset-required": add(id, assets.length > 0,
        assets.length > 0 ? undefined : "no verified uploaded assets"); break;
      case "tag-count": {
        const params = config.rules["tag-count"]?.params;
        const tags = params ? selectArtifactValues(input.json, [params.pointer ?? "/tags"])[0] : undefined;
        const ok = !!params && Array.isArray(tags) && tags.length >= params.min && (params.max === undefined || tags.length <= params.max);
        add(id, ok, ok ? undefined : !params ? "qa_rule_params_required"
          : `tags ${Array.isArray(tags) ? tags.length : 0} (min ${params.min}${params.max !== undefined ? `, max ${params.max}` : ""})`);
        break;
      }
      case "required-fields": {
        const params = config.rules["required-fields"]?.params;
        if (!params) { add(id, false, "qa_rule_params_required"); break; }
        const present = (pointer: string) => {
          const values = selectArtifactValues(input.json, [pointer]);
          return values.length > 0 && values.every(v => v !== null && v !== undefined && (typeof v !== "string" || !!v.trim()));
        };
        const missing = params.pointers.filter(pointer => !present(pointer));
        add(id, missing.length === 0, missing.length === 0 ? undefined : `${missing.length} required fields missing`);
        break;
      }
      case "no-template-remnants": {
        const params = config.rules["no-template-remnants"]?.params;
        const matched = document && params ? params.patterns.filter(pattern => document.text.includes(pattern)) : [];
        const ok = !!document && !!params && matched.length === 0;
        add(id, ok, ok ? undefined : !params ? "qa_rule_params_required" : !document ? noDocument
          : `template remnants matched: ${matched.map(pattern => JSON.stringify(pattern.slice(0, 40))).join(" ").slice(0, 120)}`);
        break;
      }
      case "asset-existence": {
        const params = config.rules["asset-existence"]?.params;
        const references = params?.pointers ? selectArtifactValues(input.json, params.pointers).flatMap(v => Array.isArray(v) ? v : [v]) : [];
        const resolved = (value: unknown) => typeof value === "string" && assets.some(asset => asset.fileName === value);
        const ok = !!params?.pointers && references.every(resolved);
        add(id, ok, ok ? undefined : !params?.pointers ? "qa_rule_params_required"
          : `${references.filter(value => !resolved(value)).length} asset references missing`);
        break;
      }
    }
  }
  if (config.rules["links-reachable"]?.enabled !== false && config.rules["links-reachable"]) {
    // Network only after every local safety check passed; a failure here is inspection loss,
    // an earlier local failure, or genuinely unreachable/over-limit sources (count only).
    const earlierOk = checks.every(check => check.ok);
    const ok = !!document && earlierOk && await qaLinksReachable(document.sourceLinks);
    add("links-reachable", ok, ok ? undefined : !document ? noDocument : !earlierOk
      ? "blocked by earlier failed checks" : `unreachable or over-limit links (${document.sourceLinks.length} sources)`);
  }
  return { ok: checks.every(check => check.ok), checks };
}
