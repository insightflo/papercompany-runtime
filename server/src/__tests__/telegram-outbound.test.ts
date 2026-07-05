import { describe, expect, it } from "vitest";
import { formatEventNotification } from "../channel/telegram/outbound.js";

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
