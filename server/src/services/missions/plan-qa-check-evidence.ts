import type { CheckResult, MissingEvidence, PlanQaScope, PlanQaVerdictState } from "@paperclipai/shared";
import { hashContract, type QualityDb } from "../quality/contract.js";
import { readVerifiedArtifact } from "../quality/evidence-store.js";
import { resolvePointer } from "../quality/evaluation-reader.js";
import { applies } from "./plan-qa-applicability.js";
import type { PlanQaManifest } from "./plan-qa-addendum-manifest.js";
import { planQaReadReceiptSchema } from "./plan-qa-addendum-gate.js";

/** Reusable evidence verification; it never writes a verdict or treats a diagnostic as authority. */
export async function inspectPlanQaChecks(db: QualityDb, scope: PlanQaScope, manifest: PlanQaManifest,
  state: PlanQaVerdictState, checks: CheckResult[]) {
  const reasons: MissingEvidence["reasons"] = [];
  const defects: Array<{ checkId: string; requirementRefs: typeof manifest.checks[number]["requirementRefs"]; templateId: string }> = [];
  const required = new Map(manifest.checks.map((check) => [check.checkId, check]));
  const submitted = new Map(checks.map((check) => [check.checkId, check]));
  const reason = (code: string, checkId: string | null, requiredKind = "read", expectedHash: string | null = null) =>
    reasons.push({ code, checkId, requiredKind, expectedHash });
  if (!required.size || required.size !== manifest.checks.length) reason("quality_plan_qa_manifest_coverage_invalid", null);
  for (const checkId of required.keys()) if (!submitted.has(checkId)) reason("quality_check_uncovered", checkId);
  for (const check of checks) {
    const definition = required.get(check.checkId);
    if (!definition) { reason("quality_check_not_applicable", check.checkId); continue; }
    const applicable = applies(definition.applicability, manifest.selectedTemplateIds);
    const start = reasons.length;
    if (check.status === "excluded" ? applicable : !applicable) reason("quality_plan_qa_excluded_unverified", check.checkId, "exclusion_verification");
    if (check.status === "insufficient_evidence" || check.status === "execution_error") reason(`quality_plan_qa_check_${check.status}`, check.checkId);
    // Only server-produced read evidence is currently a supported evidence-kind producer.
    for (const kind of definition.expectedEvidenceKinds) if (kind !== "read") reason("quality_evidence_kind_unavailable", check.checkId, kind);
    const stored = state.reads[check.checkId];
    if (!stored) { reason("quality_read_receipt_missing", check.checkId); continue; }
    if (hashContract(stored.readRef) !== hashContract(check.readRef)) {
      reason("quality_read_receipt_mismatch", check.checkId, "read", stored.readRef.sha256); continue;
    }
    try {
      const receipt = planQaReadReceiptSchema.parse(JSON.parse((await readVerifiedArtifact(db, {
        companyId: scope.companyId, ref: check.readRef, maxBytes: 2_097_152,
      })).toString("utf8")));
      const selected = receipt.pointers.map((pointer) => resolvePointer(manifest, pointer));
      if (receipt.checkId !== check.checkId || hashContract(receipt.scope) !== hashContract(scope)
        || receipt.manifestSha256 !== scope.manifestRef.sha256 || stored.manifestSha256 !== scope.manifestRef.sha256
        || hashContract(receipt.pointers) !== hashContract(stored.pointers) || hashContract(receipt.values) !== hashContract(stored.values)
        || selected.some((value) => !value.found) || hashContract(selected.map((value) => value.value)) !== hashContract(receipt.values)) {
        reason("quality_read_receipt_mismatch", check.checkId, "read", stored.readRef.sha256);
      }
    } catch { reason("quality_read_receipt_unreadable", check.checkId, "read", stored.readRef.sha256); }
    for (const ref of check.evidence) {
      try { await readVerifiedArtifact(db, { companyId: scope.companyId, ref, maxBytes: 524_288 }); }
      catch { reason("quality_evidence_unresolvable", check.checkId, "evidence", ref.sha256); }
    }
    // A defect is verified only after its evidence has passed, even if another check has technical gaps.
    if (check.status === "defect" && reasons.length === start) {
      const template = manifest.templates.find((entry) => entry.checks.some((item) => item.checkId === check.checkId));
      if (template) defects.push({ checkId: check.checkId, requirementRefs: definition.requirementRefs, templateId: template.templateId });
    }
  }
  return { reasons, defects };
}
