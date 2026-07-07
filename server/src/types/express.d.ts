export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        isInstanceAdmin?: boolean;
        keyId?: string;
        runId?: string;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "none";
        // authn 시 agentRecord 기반으로 한 번만 계산. hermes-ops-mutation-guard가 읽음.
        isHermesOpsLiaison?: boolean;
        // [P3] liaison 권한 모드(기본 advisor). mode별 allowlist가 mutation 허용 여부를 결정.
        hermesOpsMode?: "advisor" | "supervision" | "relay" | "admin";
      };
    }
  }
}
