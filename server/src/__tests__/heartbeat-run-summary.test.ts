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

  it("never splits a surrogate pair at the head or tail boundary (PG jsonb rejects lone surrogates)", () => {
    // 고립 서로게이트 검출기 — 짝 없는 상/하위 서로게이트가 있으면 true
    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const n = s.charCodeAt(i + 1);
          if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true;
        }
      }
      return false;
    };

    // 머리 경계(32768)가 페어 한가운데: 32767=상위, 32768=하위
    const headBoundary = "x".repeat(32 * 1024 - 1) + "\ud83d\ude00" + "y".repeat(70_001 - 32 * 1024 - 1);
    // 꼬리 경계(length-32768=37,233)가 페어 한가운데에 걸리도록 배치(총 길이 70,001)
    const tailBoundary = "x".repeat(37_232) + "\ud83d\ude00" + "y".repeat(70_001 - 37_234);

    for (const [label, source] of [["head", headBoundary], ["tail", tailBoundary]] as const) {
      const capped = capHeartbeatRunResultJsonForStorage({ stdout: source })!["stdout"] as string;
      expect(capped.length, `${label} boundary: bounded`).toBeLessThan(70_000);
      expect(capped).toContain("truncated");
      expect(hasLoneSurrogate(capped), `${label} boundary: no lone surrogate`).toBe(false);
      // PostgreSQL jsonb 가 “invalid input syntax”로 거부하는 고립 서로게이트가
      // JSON 직렬화→파싱 왕복 후에도 없어야 한다(저장 경로와 동일한 형태).
      const roundTrip = JSON.parse(JSON.stringify(capped)) as string;
      expect(hasLoneSurrogate(roundTrip), `${label} boundary: JSON round-trip clean`).toBe(false);
    }
  });
});
