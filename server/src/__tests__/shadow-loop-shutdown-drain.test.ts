// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { companies } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  createAgentJudgmentShadowLoop,
  type AgentShadowLoop,
} from "../services/judgment/agent-judgment-shadow-loop.js";
import {
  createPlanQaShadowLoop,
  type PlanQaShadowLoop,
} from "../services/judgment/plan-qa-shadow.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

const PRIOR_ENV = {
  PAPERCLIP_JUDGMENT_ENABLED: process.env.PAPERCLIP_JUDGMENT_ENABLED,
  AGENT_WIKI_EVOLUTION_ENABLED: process.env.AGENT_WIKI_EVOLUTION_ENABLED,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(PRIOR_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const emptyPassResult = { scanned: 0, processed: 0, recorded: 0, skipped: 0 };

describe("shadow loops shutdown owner drain contract", () => {
  let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
  let pluginDir = "";

  beforeAll(async () => {
    f = await startRuntimeShutdownProcessFixture();
    pluginDir = path.join(f.root, "empty-plugins");
    await mkdir(pluginDir, { recursive: true });
    await f.db.insert(companies).values({
      id: randomUUID(),
      name: "Shadow Drain Test Co",
      status: "active",
      issuePrefix: "SDT1",
    });
  }, 120_000);

  afterAll(async () => {
    restoreEnv();
    await f?.cleanup();
  });

  type LoopCase = {
    label: string;
    create: (opts: {
      intervalMs?: number;
      drainTimeoutMs?: number;
      runPass: () => Promise<typeof emptyPassResult>;
    }) => PlanQaShadowLoop | AgentShadowLoop;
  };

  const loopCases: LoopCase[] = [
    {
      label: "plan-qa-shadow",
      create: ({ intervalMs, drainTimeoutMs, runPass }) =>
        createPlanQaShadowLoop({ db: f.db, intervalMs, drainTimeoutMs, runPass }),
    },
    {
      label: "agent-judgment-shadow",
      create: ({ intervalMs, drainTimeoutMs, runPass }) =>
        createAgentJudgmentShadowLoop({ db: f.db, intervalMs, drainTimeoutMs, runPass }),
    },
  ];

  for (const loopCase of loopCases) {
    describe(`${loopCase.label} loop drain`, () => {
      it("waits for an in-flight tick to finish and stops scheduling new ticks", async () => {
        const started = deferred<void>();
        const release = deferred<void>();
        const runPass = vi.fn(async () => {
          started.resolve();
          await release.promise;
          return emptyPassResult;
        });
        const loop = loopCase.create({ intervalMs: 30, drainTimeoutMs: 5_000, runPass });

        try {
          loop.start();
          await started.promise;
          expect(loop.getState().running).toBe(true);

          loop.stop();
          expect(loop.getState().running).toBe(false);

          let drained = false;
          const draining = loop.drain().then(() => {
            drained = true;
          });
          expect(await settlesWithin(draining, 40)).toBe(false);
          expect(drained).toBe(false);

          release.resolve();
          await draining;
          expect(drained).toBe(true);
          expect(loop.getState().tickCount).toBe(1);
          expect(runPass).toHaveBeenCalledTimes(1);

          // No further scheduled ticks fire after stop/drain, and re-entry works cleanly.
          await new Promise((resolve) => setTimeout(resolve, 90));
          expect(runPass).toHaveBeenCalledTimes(1);

          loop.start();
          await f.waitFor(async () => (loop.getState().tickCount >= 2 ? true : null), `${loopCase.label} restart tick`, 5_000);
          await loop.drain();
          expect(loop.getState().running).toBe(false);
        } finally {
          release.resolve();
          loop.stop();
        }
      }, 30_000);

      it("respects the bounded drain limit when an in-flight tick exceeds drainTimeoutMs", async () => {
        const started = deferred<void>();
        const release = deferred<void>();
        const loop = loopCase.create({
          intervalMs: 60_000,
          drainTimeoutMs: 60,
          runPass: async () => {
            started.resolve();
            await release.promise;
            return emptyPassResult;
          },
        });

        try {
          const tickPromise = loop.observe();
          await started.promise;

          const t0 = Date.now();
          await loop.drain();
          const elapsedMs = Date.now() - t0;

          expect(elapsedMs).toBeGreaterThanOrEqual(45);
          expect(elapsedMs).toBeLessThan(1_000);
          expect(loop.getState().tickCount).toBe(0);

          release.resolve();
          await tickPromise;
          expect(loop.getState().tickCount).toBe(1);
        } finally {
          release.resolve();
          loop.stop();
        }
      }, 30_000);
    });
  }

  it("drains and disposes createApp cleanly when PAPERCLIP_JUDGMENT_ENABLED=1", async () => {
    process.env.PAPERCLIP_JUDGMENT_ENABLED = "1";
    delete process.env.AGENT_WIKI_EVOLUTION_ENABLED;
    try {
      const app = await createApp(f.db, {
        uiMode: "none",
        serverPort: 3100,
        storageService: {} as never,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
        localPluginDir: pluginDir,
      });

      await expect(app.runtimeShutdown.drain()).resolves.toBeUndefined();
      await expect(app.runtimeShutdown.dispose()).resolves.toBeUndefined();
    } finally {
      restoreEnv();
    }
  }, 60_000);

  it("preserves app.ts fail-closed policy when an enabled optional owner lacks drain()", async () => {
    process.env.PAPERCLIP_JUDGMENT_ENABLED = "0";
    process.env.AGENT_WIKI_EVOLUTION_ENABLED = "1";
    try {
      const app = await createApp(f.db, {
        uiMode: "none",
        serverPort: 3100,
        storageService: {} as never,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
        localPluginDir: pluginDir,
      });

      let caught: unknown;
      try {
        await app.runtimeShutdown.drain();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.message).toContain("Runtime shutdown producer drain failed: agent-wiki-evolution");
      expect(aggregate.errors.map((err) => (err as Error).message)).toContain(
        "enabled optional shutdown owner does not expose drain()",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      restoreEnv();
    }
  }, 60_000);

  it("exits real server child cleanly on SIGTERM without Shutdown held when PAPERCLIP_JUDGMENT_ENABLED=1", async () => {
    const server = await f.startServer(undefined, { PAPERCLIP_JUDGMENT_ENABLED: "1" });
    server.signal("SIGTERM");
    const exit = await server.waitExit(15_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(server.logs()).toContain("Server shutdown completed");
    expect(server.logs()).not.toContain("Shutdown held; database remains open");
  }, 90_000);
});
