import type { SelfImprovementAdoptionPlanEntry } from "./self-improvement-adoption-planner.js";

export type SelfImprovementAdoptionAssetStore = {
  readAsset(resolvedRef: string): Promise<string | null>;
  writeAsset(resolvedRef: string, content: string): Promise<void>;
};

export type SelfImprovementAdoptionValidationInput = {
  entry: SelfImprovementAdoptionPlanEntry;
  currentContent: string;
  patchedContent: string;
};

export type SelfImprovementAdoptionValidationResult = {
  verdict: "PASS" | "FAIL";
  reason?: string;
};

export type SelfImprovementAdoptionValidationRunner = (
  input: SelfImprovementAdoptionValidationInput,
) => Promise<SelfImprovementAdoptionValidationResult>;

// [Phase 2 — impact 원장] 채택 적용 성공 후 지식 위키 패턴에서 온 제안이면
//   company_skills.metadata.impact 등 자산별 원장에 기록하는 주입 훅.
//   실패는 무음이 아니라 impact_record_failed 진단으로 노출된다.
export type SelfImprovementAdoptionImpactRecorderInput = {
  entry: SelfImprovementAdoptionPlanEntry;
  validation: SelfImprovementAdoptionValidationResult;
};

export type SelfImprovementAdoptionImpactRecorder = (
  input: SelfImprovementAdoptionImpactRecorderInput,
) => Promise<void>;

export type SelfImprovementAdoptionAppliedEntry = {
  candidateIndex: number;
  assetRef: string;
  resolvedRef: string;
  operation: string;
  section: string;
  validationVerdict: "PASS";
  applied: true;
  /** [Phase 2] 이 채택의 근거가 된 지식 위키 패턴 카드 id — impact 원장 adoptedFrom 원천. */
  adoptedFromPatternIds: string[];
};

export type SelfImprovementAdoptionExecutorDiagnostic = {
  code:
    | "asset_read_failed"
    | "missing_patch_content"
    | "unsupported_operation"
    | "section_not_found"
    | "validation_failed"
    | "asset_write_failed"
    | "impact_record_failed";
  candidateIndex: number;
  message: string;
};

export type ApplySelfImprovementAdoptionPlanInput = {
  plan: SelfImprovementAdoptionPlanEntry[];
  assetStore: SelfImprovementAdoptionAssetStore;
  validationRunner: SelfImprovementAdoptionValidationRunner;
  impactRecorder?: SelfImprovementAdoptionImpactRecorder;
};

export type ApplySelfImprovementAdoptionPlanResult = {
  applied: SelfImprovementAdoptionAppliedEntry[];
  diagnostics: SelfImprovementAdoptionExecutorDiagnostic[];
};

type PatchResult =
  | { ok: true; content: string }
  | { ok: false; code: "missing_patch_content" | "unsupported_operation" | "section_not_found"; message: string };

function normalizePatchContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headingLevel(line: string) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

function findMarkdownSection(lines: string[], section: string) {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingLevel(lines[index] ?? "");
    if (!heading || heading.title !== section) continue;

    let end = lines.length;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextHeading = headingLevel(lines[nextIndex] ?? "");
      if (nextHeading && nextHeading.level <= heading.level) {
        end = nextIndex;
        break;
      }
    }

    return { start: index, bodyStart: index + 1, end };
  }

  return null;
}

function ensureTrailingNewline(content: string) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function applyMarkdownSectionPatch(entry: SelfImprovementAdoptionPlanEntry, currentContent: string): PatchResult {
  const { operation, section, content } = entry.proposedEdit;
  if (operation !== "add" && operation !== "replace" && operation !== "delete") {
    return {
      ok: false,
      code: "unsupported_operation",
      message: `candidate ${entry.candidateIndex} operation ${operation} is not supported by the adoption executor`,
    };
  }

  const patchContent = operation === "delete" ? null : normalizePatchContent(content);
  if (operation !== "delete" && patchContent === null) {
    return {
      ok: false,
      code: "missing_patch_content",
      message: `candidate ${entry.candidateIndex} ${operation} patch requires non-empty string content`,
    };
  }

  const lines = currentContent.split("\n");
  const sectionRange = findMarkdownSection(lines, section);
  if (!sectionRange) {
    return {
      ok: false,
      code: "section_not_found",
      message: `candidate ${entry.candidateIndex} could not find section ${section} in ${entry.asset.resolvedRef}`,
    };
  }

  const nextLines = [...lines];
  if (operation === "delete") {
    nextLines.splice(sectionRange.start, sectionRange.end - sectionRange.start);
    return { ok: true, content: ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n")) };
  }

  if (operation === "replace") {
    nextLines.splice(sectionRange.bodyStart, sectionRange.end - sectionRange.bodyStart, "", patchContent as string, "");
    return { ok: true, content: ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n")) };
  }

  let insertionIndex = sectionRange.end;
  while (insertionIndex > sectionRange.bodyStart && (nextLines[insertionIndex - 1] ?? "").trim() === "") {
    insertionIndex -= 1;
  }
  const insertLines = [patchContent as string];
  const previousLine = nextLines[insertionIndex - 1];
  const patchStartsListItem = (patchContent as string).trimStart().startsWith("- ");
  const previousLineIsListItem = previousLine?.trimStart().startsWith("- ") ?? false;
  if (previousLine && previousLine.trim() !== "" && !(patchStartsListItem && previousLineIsListItem)) {
    insertLines.unshift("");
  }
  if (nextLines[insertionIndex] && nextLines[insertionIndex].trim() !== "") {
    insertLines.push("");
  }
  nextLines.splice(insertionIndex, 0, ...insertLines);
  return { ok: true, content: ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n")) };
}

export async function applySelfImprovementAdoptionPlan({
  plan,
  assetStore,
  validationRunner,
  impactRecorder,
}: ApplySelfImprovementAdoptionPlanInput): Promise<ApplySelfImprovementAdoptionPlanResult> {
  const applied: SelfImprovementAdoptionAppliedEntry[] = [];
  const diagnostics: SelfImprovementAdoptionExecutorDiagnostic[] = [];

  for (const entry of plan) {
    const { candidateIndex } = entry;
    let currentContent: string | null;
    try {
      currentContent = await assetStore.readAsset(entry.asset.resolvedRef);
    } catch (error) {
      diagnostics.push({
        code: "asset_read_failed",
        candidateIndex,
        message: `candidate ${candidateIndex} could not read ${entry.asset.resolvedRef}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (currentContent === null) {
      diagnostics.push({
        code: "asset_read_failed",
        candidateIndex,
        message: `candidate ${candidateIndex} could not read ${entry.asset.resolvedRef}`,
      });
      continue;
    }

    const patchResult = applyMarkdownSectionPatch(entry, currentContent);
    if (!patchResult.ok) {
      diagnostics.push({ code: patchResult.code, candidateIndex, message: patchResult.message });
      continue;
    }

    const validation = await validationRunner({ entry, currentContent, patchedContent: patchResult.content });
    if (validation.verdict !== "PASS") {
      diagnostics.push({
        code: "validation_failed",
        candidateIndex,
        message: `candidate ${candidateIndex} validation did not PASS${validation.reason ? `: ${validation.reason}` : ""}`,
      });
      continue;
    }

    try {
      await assetStore.writeAsset(entry.asset.resolvedRef, patchResult.content);
    } catch (error) {
      diagnostics.push({
        code: "asset_write_failed",
        candidateIndex,
        message: `candidate ${candidateIndex} could not write ${entry.asset.resolvedRef}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    // [Phase 2] 지식 위키 패턴에서 온 채택은 impact 원장 기록이 계약의 일부 —
    //   기록 누락/실패를 무음 넘기지 않는다(자산 기록은 이미 적용됨, 원장 누락만 진단 노출).
    const patternIds = entry.evidencePatternIds ?? [];
    if (patternIds.length > 0) {
      if (!impactRecorder) {
        diagnostics.push({
          code: "impact_record_failed",
          candidateIndex,
          message: `candidate ${candidateIndex} adopted from knowledge pattern(s) ${patternIds.join(", ")} but no impact recorder was configured`,
        });
      } else {
        try {
          await impactRecorder({ entry, validation });
        } catch (error) {
          diagnostics.push({
            code: "impact_record_failed",
            candidateIndex,
            message: `candidate ${candidateIndex} impact recording failed for ${entry.asset.resolvedRef}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    applied.push({
      candidateIndex,
      assetRef: entry.asset.assetRef,
      resolvedRef: entry.asset.resolvedRef,
      operation: entry.proposedEdit.operation,
      section: entry.proposedEdit.section,
      validationVerdict: "PASS",
      applied: true,
      adoptedFromPatternIds: patternIds,
    });
  }

  return { applied, diagnostics };
}
