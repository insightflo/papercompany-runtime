import { describe, expect, it } from "vitest";
import { composeOperatorDecisionCardNotification, composeRunFailureNotification, formatEventNotification } from "../channel/telegram/outbound.js";

describe("Telegram outbound notifications", () => {
  it("suppresses normal heartbeat success events", () => {
    const message = formatEventNotification({
      type: "heartbeat.run.status",
      payload: {
        runId: "9c008cff-1111-4111-8111-111111111111",
        status: "succeeded",
      },
    });

    expect(message).toBeNull();
  });

  it("reports abnormal heartbeat terminal events", () => {
    const message = formatEventNotification({
      type: "heartbeat.run.status",
      payload: {
        runId: "9c008cff-1111-4111-8111-111111111111",
        status: "failed",
      },
    });

    expect(message).toContain("*Error*");
    expect(message).toContain("Run *9c008cff*");
    expect(message).toContain("Failed");
  });

  it("suppresses non-abnormal operational events", () => {
    expect(formatEventNotification({
      type: "plugin.worker.restarted",
      payload: { pluginKey: "insightflo.research-workbench" },
    })).toBeNull();

    expect(formatEventNotification({
      type: "plugin.ui.updated",
      payload: { action: "updated", pluginId: "plugin-1" },
    })).toBeNull();
  });

  it("reports plugin worker crashes", () => {
    const message = formatEventNotification({
      type: "plugin.worker.crashed",
      payload: {
        pluginKey: "insightflo.research-workbench",
        workerId: "worker-1234567890",
      },
    });

    expect(message).toContain("*Error*");
    expect(message).toContain("Plugin worker crashed");
    expect(message).toContain("insightflo.research-workbench");
  });

  it("reports mission human input requests without enabling success noise", () => {
    const message = formatEventNotification({
      type: "mission.human_input_requested",
      payload: {
        missionId: "934e9993-7175-4956-8c93-4fa8150fdc41",
        issueId: "6b540c35-3067-4e12-864a-79a3b08a0a76",
        issueIdentifier: "RES-935",
        issueTitle: "Resolve blocked source",
        decision: "request_input",
        reason: "Browser auth is required.",
        nextAction: "Human operator should reauthorize the session.",
      },
    });

    expect(message).toContain("*Human input required*");
    expect(message).toContain("RES-935");
    expect(message).toContain("Browser auth is required.");
    expect(message).not.toContain("*Success*");
  });
});

describe("composeOperatorDecisionCardNotification", () => {
  it("identifies the waiting issue, mission, and card title in Korean", () => {
    const message = composeOperatorDecisionCardNotification({
      title: "QA 원천 결함 — 다음 조치 선택",
      issueIdentifier: "GAZ-1315",
      issueTitle: "[OVERSIGHT] 가즈아 저녁 원천 데이터 결함 대응",
      missionTitle: "2026-08-24 gazua-evening",
    });
    expect(message).toContain("🗂️ *오너 결정 대기*");
    expect(message).toContain("이슈: GAZ-1315 — [OVERSIGHT] 가즈아 저녁 원천 데이터 결함 대응");
    expect(message).toContain("미션: 2026-08-24 gazua-evening");
    expect(message).toContain("카드: QA 원천 결함 — 다음 조치 선택");
    expect(message).toContain("→ 게시판 Human Operator 화면에서 선택");
  });

  it("degrades to a card-title-only message when issue and mission lookups fail", () => {
    const message = composeOperatorDecisionCardNotification({
      title: "QA 원천 결함 — 다음 조치 선택",
    });
    expect(message).toContain("🗂️ *오너 결정 대기*");
    expect(message).toContain("카드: QA 원천 결함 — 다음 조치 선택");
    expect(message).not.toContain("이슈:");
    expect(message).not.toContain("미션:");
  });
});

describe("composeRunFailureNotification", () => {
  const base = {
    status: "failed",
    runId: "9c008cff-1111-4111-8111-111111111111",
    agentName: "Harry Potter",
    issueIdentifier: "GAZ-1223",
    issueTitle: "[유지보수] Gazua canonical report renderer 누락",
    missionTitle: "gazua-morning-2026-08-19",
    missionId: "0d67101e-8c0a-41a3-a342-d07c42477661",
    error: "RendererError: canonical renderer missing\nstack line 2",
  };

  it("identifies agent, issue, and mission for a failed run", () => {
    const message = composeRunFailureNotification(base);
    expect(message).toContain("런 실패");
    expect(message).toContain("에이전트: Harry Potter");
    expect(message).toContain("이슈: GAZ-1223 — [유지보수] Gazua canonical report renderer 누락");
    expect(message).toContain("미션: gazua-morning-2026-08-19");
    expect(message).toContain("9c008cff");
    expect(message).toContain("에러: RendererError: canonical renderer missing");
    // only the first error line, no stack noise
    expect(message).not.toContain("stack line 2");
  });

  it("omits missing context lines instead of showing unknown", () => {
    const message = composeRunFailureNotification({
      status: "timed_out",
      runId: base.runId,
    });
    expect(message).toContain("시간 초과");
    expect(message).not.toContain("에이전트:");
    expect(message).not.toContain("이슈:");
    expect(message).not.toContain("미션:");
    expect(message).not.toContain("에러:");
  });

  it("truncates long error lines", () => {
    const message = composeRunFailureNotification({
      ...base,
      error: "E".repeat(400),
    });
    const errorLine = message.split("\n").find((line) => line.startsWith("에러:")) ?? "";
    expect(errorLine.length).toBeLessThanOrEqual("에러: ".length + 160);
  });

  it("labels cancelled runs in Korean", () => {
    const message = composeRunFailureNotification({ ...base, status: "cancelled" });
    expect(message).toContain("런 취소");
  });
});
