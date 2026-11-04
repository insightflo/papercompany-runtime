import { expect, it } from "vitest";
import { normalizeMaxConcurrentRuns } from "../services/heartbeat-concurrency-limit.js";

it("keeps heartbeat concurrency within the existing one to ten bounds", () => {
  expect(normalizeMaxConcurrentRuns(undefined)).toBe(1);
  expect(normalizeMaxConcurrentRuns(0)).toBe(1);
  expect(normalizeMaxConcurrentRuns(3.8)).toBe(3);
  expect(normalizeMaxConcurrentRuns(99)).toBe(10);
});
