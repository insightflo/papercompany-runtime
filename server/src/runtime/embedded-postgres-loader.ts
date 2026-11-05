/**
 * Embedded PostgreSQL loader that transfers SIGINT/SIGTERM ownership to this server.
 *
 * Purpose: embedded-postgres@18 registers an async-exit-hook singleton at module
 * evaluation (top-level `AsyncExitHook(gracefulShutdown)`). That singleton installs
 * SIGINT/SIGTERM listeners that stop every constructed cluster instance and then
 * force `process.exit` — concurrently with (and independently of) this server's
 * own drain-then-stop shutdown path. That race killed the owned cluster while
 * started executions were still held (see owned-postgres shutdown investigation).
 * Loading embedded-postgres ONLY through this loader removes exactly the library's
 * SIGINT/SIGTERM listeners so the server's own handlers (installed before startup)
 * are the sole owners of application shutdown signals, while `exit`/`beforeExit`
 * (and other signal) hooks are preserved so natural-exit cleanup still stops
 * otherwise-unstopped clusters.
 *
 * Identity guarantee: async-exit-hook is resolved by a require anchored at the
 * resolved embedded-postgres module path, so we mutate the SAME singleton the
 * package itself imported (pnpm isolates this dependency to that package).
 *
 * Modification cautions:
 * - Do not add awaited work between the dynamic import resolution and the unhook
 *   calls; a signal arriving inside that window falls back to the racy legacy
 *   behavior. The single awaited step below is the import itself.
 * - Fail closed: if the expected library hooks are absent or cannot be verified,
 *   throw instead of starting without signal ownership.
 * - Ownership tracking is scoped to this loader: only a prior successful transfer
 *   BY THIS LOADER makes a later call idempotent. Unexplained absent hooks are
 *   never treated as proof that ownership already happened.
 */

import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Runtime surface of the embedded-postgres instance used by server/src/index.ts. */
export type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/** Constructor options mirror the embedded-postgres package options actually used. */
export type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

/** Application shutdown signals whose library-owned listeners this loader removes. */
const OWNED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Library-hooked events that must be untouched (delta 0) by the ownership transfer. */
const RETAINED_EVENT_NAMES = ["exit", "beforeExit", "SIGHUP", "SIGBREAK", "message"] as const;

const MISSING_DEPENDENCY_MESSAGE =
  "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.";

/** Public API of async-exit-hook@2 (`module.exports` is the hook-adding function). */
type AsyncExitHookApi = {
  hookedEvents(): string[];
  unhookEvent(event: string): void;
};

export type SignalListenerSnapshot = {
  hookedEvents: string[];
  listenerCounts: Record<string, number>;
};

/** Structured before/after evidence proving exactly-one library listener per owned
 * signal was removed and unrelated listeners were retained. */
export type SignalOwnershipEvidence = {
  step: "embedded-postgres-signal-ownership";
  anchoredModulePath: string;
  exitHookModulePath: string;
  ownedSignals: readonly string[];
  before: SignalListenerSnapshot;
  after: SignalListenerSnapshot;
};

export type EmbeddedPostgresLoadResult = {
  ctor: EmbeddedPostgresCtor;
  evidence: SignalOwnershipEvidence;
  alreadyOwned: boolean;
};

let transferredOwnership: SignalOwnershipEvidence | null = null;

function snapshot(hook: AsyncExitHookApi): SignalListenerSnapshot {
  const listenerCounts: Record<string, number> = {};
  for (const name of [...OWNED_SIGNALS, ...RETAINED_EVENT_NAMES]) {
    listenerCounts[name] = process.listenerCount(name);
  }
  return { hookedEvents: hook.hookedEvents(), listenerCounts };
}

export async function loadEmbeddedPostgres(): Promise<EmbeddedPostgresLoadResult> {
  const serverRequire = createRequire(import.meta.url);
  let modulePath: string;
  try {
    modulePath = serverRequire.resolve("embedded-postgres");
  } catch {
    throw new Error(MISSING_DEPENDENCY_MESSAGE);
  }

  // The single awaited step before the unhook: evaluating the module is what
  // installs the library's exit-hook signal listeners.
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  } catch {
    throw new Error(MISSING_DEPENDENCY_MESSAGE);
  }
  if (typeof mod.default !== "function") {
    throw new Error("embedded-postgres module loaded but its constructor default export is missing");
  }
  const ctor = mod.default as EmbeddedPostgresCtor;

  if (transferredOwnership) {
    // Idempotent second load in the same process: the ESM cache returns the same
    // module without re-running its top-level registration, so do not unhook again.
    return { ctor, evidence: transferredOwnership, alreadyOwned: true };
  }

  // Everything from here to the end of this function is strictly synchronous.
  const anchoredRequire = createRequire(modulePath);
  let exitHookModulePath: string;
  let exitHook: unknown;
  try {
    exitHookModulePath = anchoredRequire.resolve("async-exit-hook");
    exitHook = anchoredRequire("async-exit-hook");
  } catch (err) {
    throw new Error(
      `Failed to resolve the async-exit-hook singleton used by embedded-postgres (${modulePath}); cannot transfer signal ownership: ${String(err)}`,
    );
  }
  const hookCandidate = (typeof exitHook === "function" ? (exitHook as unknown as Record<string, unknown>)
    : (exitHook !== null && typeof exitHook === "object" ? (exitHook as Record<string, unknown>) : null));
  if (
    hookCandidate === null
    || typeof hookCandidate.hookedEvents !== "function"
    || typeof hookCandidate.unhookEvent !== "function"
  ) {
    throw new Error("async-exit-hook singleton does not expose hookedEvents/unhookEvent; cannot transfer signal ownership");
  }
  const hook = exitHook as AsyncExitHookApi;

  const before = snapshot(hook);
  const missing = OWNED_SIGNALS.filter((signal) => !before.hookedEvents.includes(signal));
  if (missing.length > 0) {
    throw new Error(
      `embedded-postgres exit hook did not register ${missing.join(", ")} (hooked: ${before.hookedEvents.join(", ")}); refusing to start without signal ownership`,
    );
  }

  for (const signal of OWNED_SIGNALS) {
    hook.unhookEvent(signal);
  }

  const after = snapshot(hook);
  for (const signal of OWNED_SIGNALS) {
    if (after.listenerCounts[signal] !== before.listenerCounts[signal] - 1) {
      throw new Error(
        `unhooking ${signal} removed ${before.listenerCounts[signal] - after.listenerCounts[signal]} listeners (expected exactly 1); refusing to continue`,
      );
    }
    if (after.listenerCounts[signal] < 1) {
      throw new Error(
        `no remaining ${signal} listener after ownership transfer; server shutdown handlers must own application signals`,
      );
    }
    if (after.hookedEvents.includes(signal)) {
      throw new Error(`${signal} still hooked by async-exit-hook after unhookEvent`);
    }
  }
  for (const name of RETAINED_EVENT_NAMES) {
    if (after.listenerCounts[name] !== before.listenerCounts[name]) {
      throw new Error(
        `listener count for ${name} changed from ${before.listenerCounts[name]} to ${after.listenerCounts[name]} (expected no change)`,
      );
    }
  }
  if (!after.hookedEvents.includes("exit") || !after.hookedEvents.includes("beforeExit")) {
    throw new Error(
      `natural-exit cleanup hooks missing after transfer (hooked: ${after.hookedEvents.join(", ")})`,
    );
  }

  const evidence: SignalOwnershipEvidence = {
    step: "embedded-postgres-signal-ownership",
    anchoredModulePath: modulePath,
    exitHookModulePath,
    ownedSignals: [...OWNED_SIGNALS],
    before,
    after,
  };
  transferredOwnership = evidence;
  return { ctor, evidence, alreadyOwned: false };
}
