import { describe, it, expect } from "vitest";
import { createWorkflowDefinitionSchema, workflowStepDefinitionSchema } from "./workflow.js";

describe("workflowStepDefinitionSchema retry fields", () => {
  it("accepts valid fixed backoff with delay and jitter", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      onFailure: "retry",
      maxRetries: 3,
      graphRetryDelaySeconds: 5,
      graphRetryBackoff: "fixed",
      graphRetryJitter: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts linear and exponential backoff", () => {
    for (const backoff of ["linear", "exponential"] as const) {
      const result = workflowStepDefinitionSchema.safeParse({
        id: "step-1",
        graphRetryBackoff: backoff,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts delay zero", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted retry fields (backward compat)", () => {
    const result = workflowStepDefinitionSchema.safeParse({ id: "step-1" });
    expect(result.success).toBe(true);
  });

  it("rejects negative delay", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional delay", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown backoff", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryBackoff: "aggressive",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean jitter", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryJitter: "yes" as unknown as boolean,
    });
    expect(result.success).toBe(false);
  });

  it("keeps maxRetries non-negative with no upper bound", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      maxRetries: 9999,
    });
    expect(result.success).toBe(true);
  });
});

describe("createWorkflowDefinitionSchema runInputs", () => {
  const base = { name: "youtube-summary", steps: [] };

  it("accepts valid runInputs declarations and trims nothing silently", () => {
    const parsed = createWorkflowDefinitionSchema.parse({
      ...base,
      runInputs: [
        { key: "url", label: "YouTube URL", required: true, placeholder: "https://..." },
        { key: "video_id" },
      ],
    });
    expect(parsed.runInputs).toHaveLength(2);
    expect(parsed.runInputs?.[0]).toMatchObject({ key: "url", required: true });
    expect(parsed.runInputs?.[1]).toMatchObject({ key: "video_id" });
  });

  it("accepts omitted runInputs (backward compat)", () => {
    expect(createWorkflowDefinitionSchema.parse(base).runInputs).toBeUndefined();
  });

  it("rejects invalid key patterns", () => {
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs: [{ key: "bad-key" }] })).toThrow();
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs: [{ key: "" }] })).toThrow();
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs: [{ key: "a".repeat(41) }] })).toThrow();
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs: [{ key: "한글키" }] })).toThrow();
  });

  it("rejects more than 5 runInputs", () => {
    const runInputs = Array.from({ length: 6 }, (_, index) => ({ key: `k${index}` }));
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs })).toThrow();
  });

  it("rejects unknown fields in a run input", () => {
    expect(() => createWorkflowDefinitionSchema.parse({ ...base, runInputs: [{ key: "url", oops: true }] })).toThrow();
  });
});

describe("workflowRunInputSchema deriveFrom", () => {
  const base = { name: "youtube-report", steps: [] };

  it("accepts a named-extractor deriveFrom declaration", () => {
    const parsed = createWorkflowDefinitionSchema.parse({
      ...base,
      runInputs: [
        { key: "url", label: "YouTube URL", required: true },
        { key: "videoId", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
      ],
    });
    expect(parsed.runInputs?.[1]).toMatchObject({
      key: "videoId",
      deriveFrom: { input: "url", extract: "youtubeVideoId" },
    });
  });

  it("rejects unknown extractor names", () => {
    expect(() => createWorkflowDefinitionSchema.parse({
      ...base,
      runInputs: [
        { key: "url" },
        { key: "videoId", deriveFrom: { input: "url", extract: "evilRegex" } },
      ],
    })).toThrow();
    expect(() => createWorkflowDefinitionSchema.parse({
      ...base,
      runInputs: [
        { key: "url" },
        { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId", pattern: ".*" } },
      ],
    })).toThrow();
  });

  it("rejects deriveFrom with an empty source input reference", () => {
    expect(() => createWorkflowDefinitionSchema.parse({
      ...base,
      runInputs: [
        { key: "url" },
        { key: "videoId", deriveFrom: { input: "", extract: "youtubeVideoId" } },
      ],
    })).toThrow();
  });
});
