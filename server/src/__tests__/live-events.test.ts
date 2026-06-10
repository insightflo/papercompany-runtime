import { describe, expect, it } from "vitest";
import { publishLiveEvent, subscribeCompanyLiveEvents } from "../services/live-events.js";

describe("live-events", () => {
  it("delivers company-scoped events to wildcard subscribers", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("*", (event) => {
      received.push(event);
    });

    try {
      publishLiveEvent({
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { runId: "run-1", status: "succeeded" },
      });

      expect(received).toEqual([
        expect.objectContaining({
          companyId: "company-1",
          type: "heartbeat.run.status",
          payload: { runId: "run-1", status: "succeeded" },
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });
});
