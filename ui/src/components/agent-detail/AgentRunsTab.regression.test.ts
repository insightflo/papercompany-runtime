import { describe, expect, it } from "vitest";
import type { HeartbeatRunSummary } from "@paperclipai/shared";
import { createDirectLinkedRunStub } from "../../lib/heartbeat-run-stub";

describe("createDirectLinkedRunStub", () => {
  it("creates a stub with the given run id", () => {
    const stub = createDirectLinkedRunStub("run-999", "co-1", "agent-1");
    expect(stub.id).toBe("run-999");
    expect(stub.companyId).toBe("co-1");
    expect(stub.agentId).toBe("agent-1");
  });

  it("stub has enough fields for RunDetail to trigger heartbeatsApi.get", () => {
    const stub: HeartbeatRunSummary = createDirectLinkedRunStub("run-999", "co-1", "agent-1");
    expect(stub.id).toBeTruthy();
    expect(stub.invocationSource).toBe("on_demand");
    expect(stub.status).toBe("queued");
    expect(stub.createdAt).toBeInstanceOf(Date);
  });
});
