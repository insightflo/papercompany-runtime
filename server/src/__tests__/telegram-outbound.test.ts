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
});
