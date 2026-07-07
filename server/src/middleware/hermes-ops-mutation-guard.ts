// [파일 목적] Hermes Ops(operations-liaison) 에이전트의 직접 mutation을 막는 최소 기계적 denylist.
//   prompt-only 금지에 의존하지 않고 API/service layer에서 차단.
// [주요 흐름] route middleware로 부착 → req.actor.isHermesOpsLiaison 참이면 403 + 구조화 로그.
// [외부 연결] isHermesOpsLiaison 플래그는 middleware/auth.ts 에서 authn 시 agentRecord 기반으로
//   한 번만 계산해 부착(DB 재쿼리 없음). isMissionExecutionLiaisonAgent(agent-role-boundaries.ts).
// [수정시 주의]
//   - 새 mutation 라우트를 liaison이 쓰면 안 되면 이 guard를 route middleware로 부착할 것.
//   - board local_implicit(keyless→board admin, local_trusted 개발 모드) 경로는 agentRecord가
//     없어 플래그가 undefined → 통과. 이 residual은 P3(identity 전파 + board guard 강화)에서 폐쇄.
import type { RequestHandler } from "express";
import { logger } from "./logger.js";

export function hermesOpsMutationGuard(action: string): RequestHandler {
  return (req, res, next) => {
    if (!req.actor?.isHermesOpsLiaison) {
      next();
      return;
    }
    const params = (req.params ?? {}) as Record<string, string>;
    // [주의] 동기 체크라 throw 경로 없음. 플래그는 authn에서 이미 결정됨. fail-closed(참일 때만 차단).
    logger.warn(
      {
        action,
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
        companyId: req.actor.companyId ?? null,
        source: req.actor.source ?? null,
        issueId: params.id ?? params.issueId ?? null,
        method: req.method,
        url: req.originalUrl,
      },
      "hermes-ops liaison mutation blocked by denylist",
    );
    res.status(403).json({
      error: "hermes_ops_mutation_forbidden",
      action,
      message:
        "Hermes Ops liaison must not directly mutate workflow/artifact/workProduct/issue state. Use supervision/run or post an operator-visible comment instead.",
    });
  };
}
