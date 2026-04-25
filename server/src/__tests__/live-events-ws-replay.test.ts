import { describe, expect, it } from "vitest";
import {
  parseHeartbeatReplayCursors,
  replayHeartbeatRunEvents,
} from "../realtime/live-events-ws.js";

describe("live websocket heartbeat run replay", () => {
  it("parses repeated heartbeatRun replay cursors from the websocket URL", () => {
    const url = new URL(
      "http://localhost/api/companies/company-1/events/ws?heartbeatRun=run-1:3&heartbeatRun=run-2:0&heartbeatRun=bad&heartbeatRun=run-3:not-a-number",
    );

    expect(parseHeartbeatReplayCursors(url)).toEqual([
      { runId: "run-1", afterSeq: 3 },
      { runId: "run-2", afterSeq: 0 },
      { runId: "run-3", afterSeq: 0 },
    ]);
  });

  it("replays durable heartbeat run events after the requested seq and skips other companies", async () => {
    const sent: unknown[] = [];

    const count = await replayHeartbeatRunEvents({
      companyId: "company-1",
      cursors: [
        { runId: "run-1", afterSeq: 1 },
        { runId: "run-2", afterSeq: 0 },
      ],
      listEvents: async (runId, afterSeq) => {
        if (runId === "run-1") {
          expect(afterSeq).toBe(1);
          return [
            {
              id: 10,
              companyId: "company-1",
              runId: "run-1",
              agentId: "agent-1",
              seq: 2,
              eventType: "progress",
              stream: "system",
              level: "info",
              color: null,
              message: "second event",
              payload: { ok: true },
              createdAt: new Date("2026-04-25T14:00:00.000Z"),
            },
            {
              id: 11,
              companyId: "other-company",
              runId: "run-1",
              agentId: "agent-1",
              seq: 3,
              eventType: "progress",
              stream: "system",
              level: "info",
              color: null,
              message: "wrong company",
              payload: {},
              createdAt: new Date("2026-04-25T14:00:01.000Z"),
            },
          ];
        }
        return [];
      },
      send: (event) => sent.push(event),
    });

    expect(count).toBe(1);
    expect(sent).toEqual([
      {
        id: 10,
        companyId: "company-1",
        type: "heartbeat.run.event",
        createdAt: "2026-04-25T14:00:00.000Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: 2,
          eventType: "progress",
          stream: "system",
          level: "info",
          color: null,
          message: "second event",
          payload: { ok: true },
          replay: true,
        },
      },
    ]);
  });
});
