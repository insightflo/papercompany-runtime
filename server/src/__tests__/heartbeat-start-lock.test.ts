import { expect, it } from "vitest";
import { withAgentStartLock } from "../services/heartbeat-start-lock.js";

it("serializes a single agent and releases the queue after rejection", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const first = withAgentStartLock("agent-a", async () => { calls.push("first"); await held; throw new Error("failed"); });
  const rejected = expect(first).rejects.toThrow("failed");
  const second = withAgentStartLock("agent-a", async () => { calls.push("second"); });
  const other = withAgentStartLock("agent-b", async () => { calls.push("other"); });
  await other;
  expect(calls).toEqual(["first", "other"]);
  release();
  await rejected;
  await second;
  expect(calls).toEqual(["first", "other", "second"]);
});
