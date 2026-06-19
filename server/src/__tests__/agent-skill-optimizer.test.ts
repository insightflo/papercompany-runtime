import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  appendLessonBlock,
  buildLessonBlock,
  createAgentWikiEvolutionLoop,
  hasLessonBlock,
  removeLessonBlock,
  resolveAgentWikiEvolutionOwnership,
  type RunWikiEvolutionPassOptions,
  type WikiEvolutionPassResult,
} from "../services/agent-skill-optimizer.js";

describe("agent-skill-optimizer bounded-edit helpers", () => {
  it("appends a marker block, preserves the original prompt, and is detectable", () => {
    const prompt = "You are an agent.\nDo the task.";
    const next = appendLessonBlock(prompt, "entry-1", "workProduct 미등록", "POST /work-products 로 등록");
    expect(hasLessonBlock(next, "entry-1")).toBe(true);
    expect(hasLessonBlock(prompt, "entry-1")).toBe(false);
    expect(next).toContain("paperclip-skill-lesson:entry-1 START -->");
    expect(next).toContain("paperclip-skill-lesson:entry-1 END -->");
    expect(next).toContain("workProduct 미등록");
    expect(next.startsWith("You are an agent.")).toBe(true);
  });

  it("is idempotent — re-append updates the body without duplicating the block", () => {
    const a = appendLessonBlock("base prompt", "L1", "pat", "sol-A");
    const b = appendLessonBlock(a, "L1", "pat", "sol-B");
    expect(hasLessonBlock(b, "L1")).toBe(true);
    expect((b.match(/paperclip-skill-lesson:L1 START -->/g) ?? []).length).toBe(1);
    expect((b.match(/paperclip-skill-lesson:L1 END -->/g) ?? []).length).toBe(1);
    expect(b).toContain("sol-B");
    expect(b).not.toContain("sol-A");
  });

  it("isolates distinct lessonIds (surgical removal of one leaves the other)", () => {
    const a = appendLessonBlock("p", "L1", "pat1", "sol1");
    const b = appendLessonBlock(a, "L2", "pat2", "sol2");
    expect(hasLessonBlock(b, "L1")).toBe(true);
    expect(hasLessonBlock(b, "L2")).toBe(true);
    const removed = removeLessonBlock(b, "L1");
    expect(hasLessonBlock(removed, "L1")).toBe(false);
    expect(hasLessonBlock(removed, "L2")).toBe(true);
  });

  it("removeLessonBlock surgically restores the original prompt", () => {
    const original = "You are an agent.";
    const withBlock = appendLessonBlock(original, "LX", "pat", "sol");
    const reverted = removeLessonBlock(withBlock, "LX");
    expect(hasLessonBlock(reverted, "LX")).toBe(false);
    expect(reverted).toBe("You are an agent.");
  });

  it("buildLessonBlock wraps the body with paired markers", () => {
    const block = buildLessonBlock("L9", "pat", "sol");
    expect(block.startsWith("<!-- paperclip-skill-lesson:L9 START -->")).toBe(true);
    expect(block.endsWith("<!-- paperclip-skill-lesson:L9 END -->")).toBe(true);
  });
});

describe("resolveAgentWikiEvolutionOwnership (env gate)", () => {
  it("defaults OFF when unset", () => {
    expect(resolveAgentWikiEvolutionOwnership({}).enabled).toBe(false);
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: undefined }).enabled).toBe(false);
  });

  it("enables on 1 or true (case-insensitive)", () => {
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "1" }).enabled).toBe(true);
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "TRUE" }).enabled).toBe(true);
  });

  it("stays OFF on 0/false/garbage", () => {
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "0" }).enabled).toBe(false);
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveAgentWikiEvolutionOwnership({ AGENT_WIKI_EVOLUTION_ENABLED: "yes" }).enabled).toBe(false);
  });
});

describe("createAgentWikiEvolutionLoop (reconciler mechanics)", () => {
  const zero: WikiEvolutionPassResult = { proposed: 0, accepted: 0, rejected: 0, skipped: 0 };

  it("evolve() calls the injected pass and records state", async () => {
    let calls = 0;
    const pass = async (
      _db: Db,
      _opts?: RunWikiEvolutionPassOptions,
    ): Promise<WikiEvolutionPassResult> => {
      calls += 1;
      return { proposed: 2, accepted: 1, rejected: 0, skipped: 3 };
    };
    const loop = createAgentWikiEvolutionLoop({ db: null as unknown as Db, runEvolutionPass: pass });
    expect(loop.getState().running).toBe(false);
    expect(loop.getState().tickCount).toBe(0);

    await loop.evolve();

    const after = loop.getState();
    expect(calls).toBe(1);
    expect(after.tickCount).toBe(1);
    expect(after.lastResult).toEqual({ proposed: 2, accepted: 1, rejected: 0, skipped: 3 });
    expect(after.lastError).toBeNull();
    expect(after.lastTickAt).not.toBeNull();
    loop.stop();
  });

  it("a throwing pass sets lastError and does not increment tickCount (looper never dies)", async () => {
    const pass = async (): Promise<WikiEvolutionPassResult> => {
      throw new Error("boom");
    };
    const loop = createAgentWikiEvolutionLoop({ db: null as unknown as Db, runEvolutionPass: pass });
    await loop.evolve(); // must NOT throw — per-tick try/catch
    const s = loop.getState();
    expect(s.tickCount).toBe(0);
    expect(s.lastError).toBe("boom");
    expect(s.lastResult).toBeNull();
    loop.stop();
  });

  it("start()/stop() toggle the running flag", () => {
    const pass = async (): Promise<WikiEvolutionPassResult> => zero;
    const loop = createAgentWikiEvolutionLoop({
      db: null as unknown as Db,
      runEvolutionPass: pass,
      intervalMs: 60_000,
    });
    expect(loop.getState().running).toBe(false);
    loop.start();
    expect(loop.getState().running).toBe(true);
    loop.stop();
    expect(loop.getState().running).toBe(false);
  });
});
