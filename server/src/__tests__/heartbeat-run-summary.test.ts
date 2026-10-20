import { describe, expect, it } from "vitest";
import { capHeartbeatRunResultJsonForStorage, summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("capHeartbeatRunResultJsonForStorage", () => {
  it("keeps short payloads untouched by reference", () => {
    const payload = { stdout: "short", stderr: "", summary: "ok" };
    expect(capHeartbeatRunResultJsonForStorage(payload)).toBe(payload);
    expect(capHeartbeatRunResultJsonForStorage(null)).toBeNull();
  });

  it("caps oversized stdout/stderr to head+tail 32KB and preserves other fields", () => {
    const stdout = "x".repeat(70_001);
    const stderr = "y".repeat(80_000);
    const capped = capHeartbeatRunResultJsonForStorage({
      stdout,
      stderr,
      summary: "keep me",
      total_cost_usd: 1.5,
    })!;
    expect(capped.summary).toBe("keep me");
    expect(capped.total_cost_usd).toBe(1.5);
    expect((capped.stdout as string).startsWith("x".repeat(32 * 1024))).toBe(true);
    expect((capped.stdout as string).endsWith("x".repeat(32 * 1024))).toBe(true);
    expect((capped.stdout as string)).toContain("truncated");
    expect((capped.stdout as string).length).toBeLessThan(70_000);
    expect((capped.stderr as string).length).toBeLessThan(70_000);
    // 원본은 불변 — 저장용 사본만 절삭된다.
    expect(stdout.length).toBe(70_001);
  });

  it("ignores non-string stdout values", () => {
    const payload = { stdout: { chunks: [1, 2, 3] } };
    expect(capHeartbeatRunResultJsonForStorage(payload)).toBe(payload);
  });
});
