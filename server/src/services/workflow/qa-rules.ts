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

/** Runtime checks remain separate from plugin checks in the durable receipt. */
export async function evaluateQaRules(input: QaRulesInput): Promise<QaRulesResult> {
  const config = resolveEffectiveQaConfig(undefined, input.config);
  const checks: QaCheck[] = [];
  let document: ReturnType<typeof inspectQaDocument> | undefined;
  try { document = inspectQaDocument(input.json, input.html, input.internalPathRoots); } catch { /* limits fail closed below */ }
  const add = (id: string, ok: boolean, detail?: string) => checks.push({ id, ok, severity: "error", ...(detail ? { detail } : {}) });
  const assets = input.assetManifest ?? [];
  for (const [id, rule] of Object.entries(config.rules)) {
    if (!rule || rule.enabled === false) continue;
    switch (id) {
      case "provenance": add(id, input.provenanceValid === true); break;
      case "result-format": add(id, input.resultValid === true); break;
      case "no-sensitive-data": add(id, !!document && !document.sensitive); break;
      case "no-external-script": add(id, !!document && !document.externalScript); break;
      case "no-external-iframe": add(id, !!document && !document.externalIframe); break;
      case "https-links": add(id, !!document && document.secureLinks); break;
      case "min-source-links": {
        const params = config.rules["min-source-links"]?.params;
        if (!params) { add(id, false, "qa_rule_params_required"); break; }
        const links = params.pointers ? selectArtifactValues(input.json, params.pointers).flatMap(v => Array.isArray(v) ? v : [v])
          .filter((v): v is string => typeof v === "string" && /^https:\/\//i.test(v)) : document?.sourceLinks ?? [];
        add(id, new Set(links).size >= params.min); break;
      }
      case "links-reachable": break; // Network follows all local safety checks below.
      case "uploaded-asset-required": add(id, assets.length > 0); break;
      case "tag-count": {
        const params = config.rules["tag-count"]?.params;
        const tags = params ? selectArtifactValues(input.json, [params.pointer ?? "/tags"])[0] : undefined;
        add(id, !!params && Array.isArray(tags) && tags.length >= params.min && (params.max === undefined || tags.length <= params.max)); break;
      }
      case "required-fields": {
        const params = config.rules["required-fields"]?.params;
        add(id, !!params && params.pointers.every(pointer => {
          const values = selectArtifactValues(input.json, [pointer]);
          return values.length > 0 && values.every(v => v !== null && v !== undefined && (typeof v !== "string" || !!v.trim()));
        })); break;
      }
      case "no-template-remnants": {
        const params = config.rules["no-template-remnants"]?.params;
        add(id, !!document && !!params && params.patterns.every(pattern => !document.text.includes(pattern))); break;
      }
      case "asset-existence": {
        const params = config.rules["asset-existence"]?.params;
        const references = params?.pointers ? selectArtifactValues(input.json, params.pointers).flatMap(v => Array.isArray(v) ? v : [v]) : [];
        add(id, !!params?.pointers && references.every(v => typeof v === "string" && assets.some(asset => asset.fileName === v))); break;
      }
    }
  }
  if (config.rules["links-reachable"]?.enabled !== false && config.rules["links-reachable"]) {
    add("links-reachable", !!document && checks.every(check => check.ok) && await qaLinksReachable(document.sourceLinks));
  }
  return { ok: checks.every(check => check.ok), checks };
}
