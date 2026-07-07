// [파일 목적] Hermes Ops(operations-liaison) 에이전트의 직접 mutation을 mode별 명시 allowlist로
//   기계적으로 차단/허용. prompt-only 금지나 display name에 의존하지 않는다.
// [주요 흐름] route middleware로 부착 → req.actor.isHermesOpsLiaison 참이면 해당 mode의 allowlist로
//   action 허용 여부 판정 → 허용 아니면 403 + 구조화 로그.
// [외부 연결] isHermesOpsLiaison / hermesOpsMode는 middleware/auth.ts 가 authn 시
//   resolveHermesOpsLiaisonIdentity(agent-role-boundaries.ts)로 산출해 req.actor에 부착.
// [수정시 주의]
//   - 새 mutation 라우트를 liaison이 쓰면 안 되면 이 guard를 route middleware로 부착할 것.
//   - mode를 새로 허용하려면 MODE_ALLOWED_MUTATIONS에 action을 추가(설정 기반, guard 재작성 不必要).
//   - board local_implicit(keyless→board admin, local_trusted 개발 모드) 경로는 agentRecord가 없어
//     isHermesOpsLiaison=undefined → 통과. residual(별도 board guard 강화로 폐쇄 예정).
import type { RequestHandler } from "express";
import { logger } from "./logger.js";

type HermesOpsMode = "advisor" | "supervision" | "relay" | "admin";

// [P3] mode별 허용 mutation action. advisor/supervision/relay은 직접 workflow/artifact/workProduct/
//   issue-status mutation을 할 수 없다 — 각 모드의 허용 동작(supervision/run, comments relay)은
//   이 guard가 부착되지 않은 별도 라우트로 처리. admin만 explicit operator 한정 전부 허용(향후).
//   action 문자열은 routes/* 에서 hermesOpsMutationGuard("...") 로 넘기는 값과 일치.
const MODE_ALLOWED_MUTATIONS: Record<HermesOpsMode, ReadonlySet<string> | "*"> = {
  advisor: new Set<string>(),
  supervision: new Set<string>(),
  relay: new Set<string>(),
  admin: "*",
};

export function hermesOpsMutationGuard(action: string): RequestHandler {
  return (req, res, next) => {
    if (!req.actor?.isHermesOpsLiaison) {
      next();
      return;
    }
    const mode: HermesOpsMode = req.actor.hermesOpsMode ?? "advisor";
    const allowed = MODE_ALLOWED_MUTATIONS[mode];
    // [주의] 동기 체크라 throw 경로 없음. 허용이면 pass, 아니면 fail-closed(차단).
    if (allowed === "*" || allowed.has(action)) {
      next();
      return;
    }
    const params = (req.params ?? {}) as Record<string, string>;
    logger.warn(
      {
        action,
        mode,
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
        companyId: req.actor.companyId ?? null,
        source: req.actor.source ?? null,
        issueId: params.id ?? params.issueId ?? null,
        method: req.method,
        url: req.originalUrl,
      },
      "hermes-ops liaison mutation blocked by mode allowlist",
    );
    res.status(403).json({
      error: "hermes_ops_mutation_forbidden",
      action,
      mode,
      message:
        "Hermes Ops liaison must not directly mutate workflow/artifact/workProduct/issue state. Use supervision/run or post an operator-visible comment instead.",
    });
  };
}
