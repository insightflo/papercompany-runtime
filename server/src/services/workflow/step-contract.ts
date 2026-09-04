import type { WorkflowStepContract, WorkflowStepMachineCheck } from "@paperclipai/shared";

/**
 * [purpose] Step dispatch contract helpers — 발주 계약(사전조건/사후조건/미정의동작) 정규화.
 * 정의 stepsJson 은 zod 검증 없이 로드되는 legacy/plugin 정의도 있으므로,
 * 렌더·실행카드 기록 전에 이 방어적 정규화를 반드시 거친다(빈 항목 제거·트림·전부 비면 null).
 * [care] 규칙 8 — 계약은 지침·QA 검증 기준·구조 레코드일 뿐 실행 통제 권위가 아니다.
 * 런타임 코드가 계약 텍스트를 파싱해 성패/재시도/완료를 판정해서는 안 된다.
 */
export function normalizeWorkflowStepContract(raw: unknown): WorkflowStepContract | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const readSection = (key: string): string[] | undefined => {
    const value = record[key];
    if (!Array.isArray(value)) return undefined;
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  };
  const preconditions = readSection("preconditions");
  const postconditions = readSection("postconditions");
  const undefinedBehaviors = readSection("undefinedBehaviors");
  const machineChecks = normalizeWorkflowStepMachineChecks(record.machineChecks);
  if (!preconditions && !postconditions && !undefinedBehaviors && !machineChecks) return null;
  return {
    ...(preconditions ? { preconditions } : {}),
    ...(postconditions ? { postconditions } : {}),
    ...(undefinedBehaviors ? { undefinedBehaviors } : {}),
    ...(machineChecks ? { machineChecks } : {}),
  };
}

const MACHINE_CHECK_KINDS = new Set(["file_exists", "file_glob", "min_size_bytes", "content_sha256"]);
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/u;
const MAX_MACHINE_CHECKS = 20;

function readTrimmedCheckString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * [purpose] machineChecks 방어적 정규화 — legacy/plugin stepsJson 은 zod 검증 없이
 * 로드될 수 있으므로, 네 종류의 기계 검증 술어만 구조적으로 남기고 나머지는 drop 한다.
 * [care] 규칙 8 — 자연어 텍스트 파싱 금지. 필드 키 기반 구조 읽기만 수행한다.
 */
export function normalizeWorkflowStepMachineChecks(raw: unknown): WorkflowStepMachineCheck[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const checks: WorkflowStepMachineCheck[] = [];
  for (const entry of raw) {
    if (checks.length >= MAX_MACHINE_CHECKS) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind.trim() : "";
    if (!MACHINE_CHECK_KINDS.has(kind)) continue;
    if (kind === "file_exists") {
      const target = readTrimmedCheckString(record.path, 500);
      if (target) checks.push({ kind: "file_exists", path: target });
    } else if (kind === "file_glob") {
      const dir = readTrimmedCheckString(record.dir, 500);
      const glob = readTrimmedCheckString(record.glob, 200);
      if (!dir || !glob) continue;
      const minCount = record.minCount === undefined ? 1 : readNonNegativeInt(record.minCount);
      if (minCount === null || minCount < 1) continue;
      checks.push({ kind: "file_glob", dir, glob, minCount });
    } else if (kind === "min_size_bytes") {
      const target = readTrimmedCheckString(record.path, 500);
      const minBytes = readNonNegativeInt(record.minBytes);
      if (target && minBytes !== null) checks.push({ kind: "min_size_bytes", path: target, minBytes });
    } else {
      const target = readTrimmedCheckString(record.path, 500);
      const sha256 = readTrimmedCheckString(record.sha256, 64);
      if (target && sha256 && SHA256_HEX_RE.test(sha256)) checks.push({ kind: "content_sha256", path: target, sha256 });
    }
  }
  return checks.length > 0 ? checks : undefined;
}
