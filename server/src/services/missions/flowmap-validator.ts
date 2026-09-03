// server/src/services/missions/flowmap-validator.ts
//
// [파일 목적] repo-flowmap 스킬의 scripts/validate_flowmap.mjs 를 TS로 1:1 이식한 검증기.
//   flowmap.json 규격(고정 렌더러 계약)의 무결성 규칙을 그대로 유지한다 — 규칙 추가/변경 금지.
//   원본과 달라지면 렌더러가 조용히 edge 를 drop 하는 사고가 난다(눈으로만 검증하지 않는다 계약).
// [외부 연결] consumer: mission-flowmap-export.ts(빌더 출력 self-check), __tests__/mission-flowmap-export.
// [수정시 주의] 원본 .mjs 규칙 세트와 동기 유지. 색상 regex/12자 라벨 제한/내부처리 step state 금지 포함.

const allowedSides = new Set(["top", "right", "bottom", "left", "n", "e", "s", "w"]);
const allowedStates = new Set(["failover", "blocked", "cond"]);
const flowIdPattern = /^[A-Za-z0-9_-]+$/;
const colorPattern =
  /^(#[0-9A-Fa-f]{3,8}|var\(--[A-Za-z0-9_-]+\)|[A-Za-z]+|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\sdegrad]+\))$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** flowmap 문서를 검증하고 규칙 위반 목록을 반환한다(빈 배열 = 통과). */
export function validateFlowmap(data: unknown): string[] {
  const errors: string[] = [];
  const needObject = (value: unknown, at: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) errors.push(`${at}: 객체가 필요합니다`);
  };
  const needArray = (value: unknown, at: string) => {
    if (!Array.isArray(value)) errors.push(`${at}: 배열이 필요합니다`);
  };
  const duplicateIds = (items: unknown, at: string): Set<string> => {
    const ids = new Set<string>();
    if (!Array.isArray(items)) return ids;
    items.forEach((item, index) => {
      const id = isPlainObject(item) ? item.id : undefined;
      if (typeof id !== "string" || !id.trim()) {
        errors.push(`${at}[${index}].id: 비어 있지 않은 문자열이 필요합니다`);
      } else if (ids.has(id)) {
        errors.push(`${at}: 중복 id "${id}"`);
      } else {
        ids.add(id);
      }
    });
    return ids;
  };

  needObject(data, "root");
  if (!isPlainObject(data)) return errors;
  const meta = data.meta;
  needObject(meta, "meta");
  needArray(data.layers, "layers");
  needArray(data.nodes, "nodes");
  needArray(data.flows, "flows");
  if (!isPlainObject(meta) || typeof meta.project !== "string" || !meta.project.trim()) {
    errors.push("meta.project: 비어 있지 않은 문자열이 필요합니다");
  }
  if (!isPlainObject(meta) || typeof meta.last_analyzed_commit !== "string" || !meta.last_analyzed_commit.trim()) {
    errors.push("meta.last_analyzed_commit: 비어 있지 않은 문자열이 필요합니다");
  }

  const layerIds = duplicateIds(data.layers, "layers");
  const nodeIds = duplicateIds(data.nodes, "nodes");
  duplicateIds(data.flows, "flows");

  (Array.isArray(data.layers) ? data.layers : []).forEach((layer, index) => {
    if (!isPlainObject(layer)) return;
    if (typeof layer.label !== "string" || !layer.label.trim()) {
      errors.push(`layers[${index}].label: 비어 있지 않은 문자열이 필요합니다`);
    }
    if (layer.color != null && (typeof layer.color !== "string" || !colorPattern.test(layer.color.trim()))) {
      errors.push(`layers[${index}].color: 허용되지 않는 색상 값 "${String(layer.color)}"`);
    }
  });

  (Array.isArray(data.nodes) ? data.nodes : []).forEach((node, index) => {
    if (!isPlainObject(node)) {
      errors.push(`nodes[${index}]: 객체가 필요합니다`);
      return;
    }
    if (!layerIds.has(String(node.layer))) errors.push(`nodes[${index}].layer: 존재하지 않는 "${String(node.layer)}"`);
    if (!node.label) errors.push(`nodes[${index}].label: 필수입니다`);
  });

  (Array.isArray(data.flows) ? data.flows : []).forEach((flow, flowIndex) => {
    if (!isPlainObject(flow)) {
      errors.push(`flows[${flowIndex}]: 객체가 필요합니다`);
      return;
    }
    if (!flow.title) errors.push(`flows[${flowIndex}].title: 필수입니다`);
    if (typeof flow.id === "string" && !flowIdPattern.test(flow.id)) {
      errors.push(`flows[${flowIndex}].id: URL 해시 복원을 위해 영숫자·_·-만 허용됩니다 ("${flow.id}")`);
    }
    if (!Array.isArray(flow.steps)) {
      errors.push(`flows[${flowIndex}].steps: 배열이 필요합니다`);
      return;
    }
    if (flow.status != null && flow.status !== "stale") {
      errors.push(`flows[${flowIndex}].status: "stale"만 허용됩니다`);
    }
    flow.steps.forEach((step, stepIndex) => {
      const at = `flows[${flowIndex}].steps[${stepIndex}]`;
      if (!isPlainObject(step)) {
        errors.push(`${at}: 객체가 필요합니다`);
        return;
      }
      if (!nodeIds.has(String(step.from))) errors.push(`${at}.from: 존재하지 않는 "${String(step.from)}"`);
      if (!nodeIds.has(String(step.to))) errors.push(`${at}.to: 존재하지 않는 "${String(step.to)}"`);
      for (const key of ["fromSide", "toSide"] as const) {
        if (step[key] != null && !allowedSides.has(String(step[key]))) {
          errors.push(`${at}.${key}: 허용되지 않는 "${String(step[key])}"`);
        }
      }
      if (step.kind != null && step.kind !== "self") errors.push(`${at}.kind: "self"만 허용됩니다`);
      if (step.state != null) {
        if (!allowedStates.has(String(step.state))) {
          errors.push(`${at}.state: failover·blocked·cond만 허용됩니다 ("${String(step.state)}")`);
        } else if (step.from === step.to && step.kind !== "self" && step.recursive !== true) {
          // 내부 처리 단계는 바깥 선이 없어서 상태를 그릴 자리가 없다.
          errors.push(`${at}.state: 모듈 내부 처리 단계에는 쓸 수 없습니다`);
        }
      }
      if (step.stateLabel != null) {
        if (typeof step.stateLabel !== "string" || !step.stateLabel.trim()) {
          errors.push(`${at}.stateLabel: 비어 있지 않은 문자열이 필요합니다`);
        } else if (step.stateLabel.length > 12) {
          errors.push(`${at}.stateLabel: 12자 이하여야 합니다 ("${step.stateLabel}")`);
        }
        if (step.state == null) errors.push(`${at}.stateLabel: state 없이 쓸 수 없습니다`);
      }
      if ((step.kind === "self" || step.recursive === true) && step.from !== step.to) {
        errors.push(`${at}: self/recursive는 from === to에서만 허용됩니다`);
      }
      if (step.recursive != null && typeof step.recursive !== "boolean") {
        errors.push(`${at}.recursive: boolean이 필요합니다`);
      }
    });
  });
  return errors;
}
