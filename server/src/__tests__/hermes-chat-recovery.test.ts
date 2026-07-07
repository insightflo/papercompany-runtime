import { beforeEach, describe, expect, it, vi } from "vitest";

// getMissionRecoveryAdvice(DB 쿼리)를 mock해 detect/resolve 로직만 단위 테스트.
vi.mock("../services/missions/mission-recovery-advice.js", () => ({
  getMissionRecoveryAdvice: vi.fn(),
}));

import {
  detectRecoveryQuestion,
  resolveMissionIdForRecovery,
  resolveRecoveryAdviceForChat,
} from "../services/hermes-chat-recovery.js";
import { getMissionRecoveryAdvice } from "../services/missions/mission-recovery-advice.js";
import { logger } from "../middleware/logger.js";

const db = {} as never;
const UUID = "0b88ac0e-e9cd-4973-b83b-ec119c18c7f2";

describe("detectRecoveryQuestion", () => {
  it("detects Korean recovery questions", () => {
    expect(detectRecoveryQuestion("왜 멈췄어? 깨우려면 뭐라고 해?")).toBe(true);
    expect(detectRecoveryQuestion("왜 멈췄어?")).toBe(true);
    expect(detectRecoveryQuestion("이거 막힌 사유가 뭐야?")).toBe(true);
    expect(detectRecoveryQuestion("QA가 막혔는데 어떻게 풀까?")).toBe(true);
  });

  it("detects English recovery questions", () => {
    expect(detectRecoveryQuestion("why is this stopped?")).toBe(true);
    expect(detectRecoveryQuestion("QA is stuck, what now?")).toBe(true);
    expect(detectRecoveryQuestion("how do I unblock this?")).toBe(true);
  });

  it("returns false for non-recovery messages and empty input", () => {
    expect(detectRecoveryQuestion("안녕하세요, 상태 보여줘")).toBe(false);
    expect(detectRecoveryQuestion("오늘 날씨 어때?")).toBe(false);
    expect(detectRecoveryQuestion("")).toBe(false);
    expect(detectRecoveryQuestion(null)).toBe(false);
    expect(detectRecoveryQuestion(undefined)).toBe(false);
  });
});

describe("resolveMissionIdForRecovery", () => {
  it("extracts missionId from sidebar pageContext kind=mission + entityId", () => {
    expect(
      resolveMissionIdForRecovery({ currentPage: { kind: "mission", entityId: UUID }, messageText: "" }),
    ).toBe(UUID);
  });

  it("extracts missionId from pageContext facts.missionId", () => {
    expect(
      resolveMissionIdForRecovery({ currentPage: { facts: { missionId: UUID } }, messageText: "" }),
    ).toBe(UUID);
  });

  it("extracts missionId from pageContext path", () => {
    expect(
      resolveMissionIdForRecovery({
        currentPage: { path: `/companies/c/missions/${UUID}/issues` },
        messageText: "",
      }),
    ).toBe(UUID);
  });

  it("extracts missionId from a Telegram message URL when currentPage is null", () => {
    expect(
      resolveMissionIdForRecovery({
        currentPage: null,
        messageText: `왜 멈췄어? https://app.example.com/missions/${UUID}`,
      }),
    ).toBe(UUID);
  });

  it("returns null when no mission id is recoverable from either source", () => {
    expect(resolveMissionIdForRecovery({ currentPage: null, messageText: "왜 멈췄어?" })).toBeNull();
    expect(
      resolveMissionIdForRecovery({ currentPage: { kind: "company" }, messageText: "hi" }),
    ).toBeNull();
  });
});

describe("resolveRecoveryAdviceForChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and does NOT call the advice service for non-recovery questions", async () => {
    const result = await resolveRecoveryAdviceForChat(db, {
      companyId: "co-1",
      currentPage: { kind: "mission", entityId: UUID },
      messageText: "안녕하세요",
    });

    expect(result).toBeNull();
    expect(getMissionRecoveryAdvice).not.toHaveBeenCalled();
  });

  it("returns null when the question is a recovery question but missionId cannot be resolved", async () => {
    const result = await resolveRecoveryAdviceForChat(db, {
      companyId: "co-1",
      currentPage: null,
      messageText: "왜 멈췄어?",
    });

    expect(result).toBeNull();
    expect(getMissionRecoveryAdvice).not.toHaveBeenCalled();
  });

  it("computes advice when a recovery question has a resolvable missionId", async () => {
    (getMissionRecoveryAdvice as vi.Mock).mockResolvedValue({
      missionId: UUID,
      selectedIssueId: null,
      decision: "producer_rework",
      targetIssue: null,
      targetAction: "rework",
      leafCause: "...",
      evidence: [],
      operatorComment: "재작업 요청",
      doNot: [],
      missingEvidence: [],
    });

    const result = await resolveRecoveryAdviceForChat(db, {
      companyId: "co-1",
      currentPage: { kind: "mission", entityId: UUID },
      messageText: "왜 멈췄어? 깨우려면 뭐라고 해?",
    });

    expect(result).not.toBeNull();
    expect(result?.decision).toBe("producer_rework");
    expect(getMissionRecoveryAdvice).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      missionId: UUID,
      issueId: null,
    });
  });

  it("passes the sidebar selected issue id through when pageContext kind=issue", async () => {
    (getMissionRecoveryAdvice as vi.Mock).mockResolvedValue({ decision: "no_action" });

    await resolveRecoveryAdviceForChat(db, {
      companyId: "co-1",
      currentPage: { kind: "mission", entityId: UUID, facts: { issueId: "issue-7" } },
      messageText: "blocked reason?",
    });

    expect(getMissionRecoveryAdvice).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      missionId: UUID,
      issueId: "issue-7",
    });
  });

  it("fail-open: returns null AND warns with companyId/missionId when the advice service throws", async () => {
    (getMissionRecoveryAdvice as vi.Mock).mockRejectedValue(new Error("db down"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    const result = await resolveRecoveryAdviceForChat(db, {
      companyId: "co-1",
      currentPage: { kind: "mission", entityId: UUID },
      messageText: "왜 멈췄어?",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ companyId: "co-1", missionId: UUID });
    warnSpy.mockRestore();
  });
});
