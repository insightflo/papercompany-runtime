/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  type Db,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp, createRuntimeShutdownFlight, type AppRuntimeShutdown, type RuntimeShutdownSignal } from "./app.js";
import { toPublicSocialAuthProviders, type PublicSocialAuthProvider } from "./auth/social-providers.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { heartbeatService, reconcilePersistedAgentStatusOnStartup, reconcilePersistedRuntimeServicesOnStartup, routineService } from "./services/index.js";
import { createHeartbeatScheduler } from "./services/heartbeat-scheduler.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { runningProcesses } from "./adapters/index.js";
import { runtimeExecutionLifecycle } from "./services/runtime-execution-lifecycle.js";
import { loadEmbeddedPostgres, type EmbeddedPostgresInstance } from "./runtime/embedded-postgres-loader.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

type ServerShutdownContext = {
  startupReady: Promise<void>;
  resolveStartupReady(): void;
  rejectStartupReady(error: unknown): void;
  startupWork: Set<Promise<unknown>>;
  appShutdown: AppRuntimeShutdown | null;
  db: Db | null;
  heartbeat: ReturnType<typeof heartbeatService> | null;
  heartbeatScheduler: ReturnType<typeof createHeartbeatScheduler> | null;
  embeddedPostgres: EmbeddedPostgresInstance | null;
  embeddedPostgresStartedByThisProcess: boolean;
  shutdownFlushTimeoutMs: number;
  backupInterval: ReturnType<typeof setInterval> | null;
  backupFlight: Promise<void> | null;
  server: ReturnType<typeof createServer> | null;
  liveEvents: ReturnType<typeof setupLiveEventsWebSocketServer> | null;
  removeSignalHandlers(): void;
};

function createServerShutdownContext(): ServerShutdownContext {
  let resolveStartupReady!: () => void;
  let rejectStartupReady!: (error: unknown) => void;
  const startupReady = new Promise<void>((resolve, reject) => {
    resolveStartupReady = resolve;
    rejectStartupReady = reject;
  });
  void startupReady.catch(() => {});
  return {
    startupReady,
    resolveStartupReady,
    rejectStartupReady,
    startupWork: new Set(),
    appShutdown: null,
    db: null,
    heartbeat: null,
    heartbeatScheduler: null,
    embeddedPostgres: null,
    embeddedPostgresStartedByThisProcess: false,
    shutdownFlushTimeoutMs: 0,
    backupInterval: null,
    backupFlight: null,
    server: null,
    liveEvents: null,
    removeSignalHandlers: () => {},
  };
}

function trackStartup<T>(context: ServerShutdownContext, promise: Promise<T>): Promise<T> {
  context.startupWork.add(promise);
  void promise.then(
    () => context.startupWork.delete(promise),
    () => context.startupWork.delete(promise),
  );
  return promise;
}

async function closeRemainingIngress(context: ServerShutdownContext): Promise<void> {
  const serverClose = context.server?.listening
    ? new Promise<void>((resolveClose, rejectClose) => {
      context.server!.close((error) => error ? rejectClose(error) : resolveClose());
    })
    : Promise.resolve();

  if (context.liveEvents) {
    for (const socket of context.liveEvents.clients) socket.terminate();
    await new Promise<void>((resolveClose, rejectClose) => {
      context.liveEvents!.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
  await serverClose;
}

async function terminateDrainedChildren(
  context: ServerShutdownContext,
  signal: RuntimeShutdownSignal,
): Promise<void> {
  const trackedEntries = Array.from(runningProcesses.entries());
  if (trackedEntries.length === 0) return;

  const heartbeat = context.heartbeat;
  if (!heartbeat) throw new Error("Heartbeat service is unavailable for guarded shutdown flush");
  const flushPromise = context.shutdownFlushTimeoutMs > 0
    ? heartbeat.markRunsShutdownInterrupted(
      trackedEntries.map(([runId]) => runId),
      { signal, deadlineMs: context.shutdownFlushTimeoutMs },
    )
    : Promise.resolve(null);

  const childGraceMs = 2000;
  for (const [, tracked] of trackedEntries) {
    try {
      if (!tracked.child.killed) tracked.child.kill("SIGTERM");
    } catch {
      // A child may have exited after the fresh post-drain snapshot.
    }
  }
  const [flushResult] = await Promise.allSettled([
    flushPromise,
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, childGraceMs)),
  ]);
  for (const [runId, tracked] of trackedEntries) {
    try {
      tracked.child.kill("SIGKILL");
    } catch {
      // The child may have exited during its grace period.
    }
    if (runningProcesses.get(runId) === tracked) runningProcesses.delete(runId);
    logger.info({ runId, pid: tracked.child.pid ?? null }, "Terminated drained adapter child");
  }
  if (flushResult.status === "rejected") throw flushResult.reason;
  if (flushResult.value) logger.info({ flushSummary: flushResult.value }, "Shutdown flush complete");
}

async function performServerShutdown(
  context: ServerShutdownContext,
  signal: RuntimeShutdownSignal,
): Promise<void> {
  logger.info({ signal }, "Server shutting down");
  await context.startupReady;
  if (!context.db || !context.appShutdown) throw new Error("Server startup did not provide shutdown owners");

  while (context.startupWork.size > 0) {
    const startupBatch = [...context.startupWork];
    await Promise.allSettled(startupBatch);
  }
  if (context.backupFlight) await context.backupFlight;
  await context.appShutdown.drain();

  context.appShutdown.sealHttpIngress();
  await closeRemainingIngress(context);
  await context.appShutdown.drainHttpCallbacks();
  await context.appShutdown.drain();
  await terminateDrainedChildren(context, signal);
  await context.appShutdown.dispose();

  const client = (context.db as unknown as { $client?: { end(options: { timeout: number }): Promise<void> } }).$client;
  if (!client) throw new Error("Database client does not expose the configured close API");
  await client.end({ timeout: 5 });
  if (context.embeddedPostgres && context.embeddedPostgresStartedByThisProcess) {
    logger.info({ signal }, "Stopping embedded PostgreSQL");
    await context.embeddedPostgres.stop();
  }

  context.removeSignalHandlers();
  logger.info({ signal }, "Server shutdown completed");
}

export async function startServer(): Promise<StartedServer> {
  const context = createServerShutdownContext();
  const shutdown = createRuntimeShutdownFlight({
    beginShutdown: (signal) => { runtimeExecutionLifecycle.beginShutdown(signal); },
    stopIndexStarts() {
      context.heartbeatScheduler?.stop();
      if (context.backupInterval) {
        clearInterval(context.backupInterval);
        context.backupInterval = null;
      }
    },
    stopAppStarts: () => context.appShutdown?.stopStarts(),
    run: (signal) => performServerShutdown(context, signal),
  });
  const onSigint = () => {
    void shutdown("SIGINT").catch((err) => {
      process.exitCode = 1;
      logger.error({ err }, "Shutdown held; database remains open");
    });
  };
  const onSigterm = () => {
    void shutdown("SIGTERM").catch((err) => {
      process.exitCode = 1;
      logger.error({ err }, "Shutdown held; database remains open");
    });
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  context.removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  try {
    const started = await startServerWithRuntime(context);
    context.resolveStartupReady();
    return started;
  } catch (error) {
    context.rejectStartupReady(error);
    throw error;
  }
}

async function startServerWithRuntime(context: ServerShutdownContext): Promise<StartedServer> {
  const config = loadConfig();
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db: Db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  context.shutdownFlushTimeoutMs = config.shutdownFlushTimeoutMs;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const embeddedPostgresLoad = await loadEmbeddedPostgres();
    const EmbeddedPostgres = embeddedPostgresLoad.ctor;
    logger.info(
      { ...embeddedPostgresLoad.evidence, alreadyOwned: embeddedPostgresLoad.alreadyOwned },
      "Embedded PostgreSQL signal ownership transferred to server shutdown handlers",
    );
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const embeddedPostgresLogBuffer: string[] = [];
    const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
      for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line) continue;
        embeddedPostgresLogBuffer.push(line);
        if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
          embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
        }
        if (verboseEmbeddedPostgresLogs) {
          logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
        }
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      if (embeddedPostgresLogBuffer.length > 0) {
        logger.error(
          {
            phase,
            recentLogs: embeddedPostgresLogBuffer,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });
        context.embeddedPostgres = embeddedPostgres;

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw err;
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw err;
        }
        embeddedPostgresStartedByThisProcess = true;
        context.embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    context.db = db;
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }

  if (config.databaseUrl) context.db = db;
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let socialAuthProviders: readonly PublicSocialAuthProvider[] = [];
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const betterAuthSecret =
      process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
    if (!betterAuthSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) to be set",
      );
    }
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    socialAuthProviders = toPublicSocialAuthProviders(config.authSocialProviders);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  const listenPort = await detectPort(config.port);
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
    socialAuthProviders,
    onRuntimeShutdown(controller) {
      context.appShutdown = controller;
      if (runtimeExecutionLifecycle.shutdownState()) controller.stopStarts();
    },
    drainAdditionalProducers: async () => {
      await context.heartbeatScheduler?.drain();
    },
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
  context.server = server;
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  if (!runtimeExecutionLifecycle.shutdownState()) {
    context.liveEvents = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: config.deploymentMode,
      resolveSessionFromHeaders,
    });
    trackStartup(context, reconcilePersistedRuntimeServicesOnStartup(db)
      .then((result) => {
        if (result.reconciled > 0) {
          logger.warn(
            { reconciled: result.reconciled },
            "reconciled persisted runtime services from a previous server process",
          );
        }
      })
      .catch((err) => logger.error({ err }, "startup reconciliation of persisted runtime services failed")));
    trackStartup(context, reconcilePersistedAgentStatusOnStartup(db)
      .then((result) => {
        if (result.reconciled > 0) {
          logger.warn(
            { reconciled: result.reconciled },
            "reset phantom-running agents to idle on startup (no running heartbeat run)",
          );
        }
      })
      .catch((err) => logger.error({ err }, "startup reconciliation of persisted agent status failed")));
  }
  
  if (config.databaseBackupEnabled && !runtimeExecutionLifecycle.shutdownState()) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
  
    const runScheduledBackup = async () => {
      if (context.backupFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
      if (runtimeExecutionLifecycle.shutdownState()) return;
      const flight = (async () => {
        try {
          const result = await runDatabaseBackup({
            connectionString: activeDatabaseConnectionString,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
            filenamePrefix: "paperclip",
          });
          logger.info(
            {
              backupFile: result.backupFile,
              sizeBytes: result.sizeBytes,
              prunedCount: result.prunedCount,
              backupDir: config.databaseBackupDir,
              retentionDays: config.databaseBackupRetentionDays,
            },
            `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
          );
        } catch (err) {
          logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
        }
      })();
      context.backupFlight = flight;
      const clearFlight = () => { if (context.backupFlight === flight) context.backupFlight = null; };
      void flight.then(clearFlight, clearFlight);
      return flight;
    };
  
    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    context.backupInterval = setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
  
  if (!runtimeExecutionLifecycle.shutdownState()) {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => {
        server.off("error", onError);
        rejectListen(err);
      };

      server.once("error", onError);
      server.listen(listenPort, config.host, () => {
        server.off("error", onError);
        logger.info(`Server listening on ${config.host}:${listenPort}`);
        if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true" && !runtimeExecutionLifecycle.shutdownState()) {
          const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
          const url = `http://${openHost}:${listenPort}`;
          trackStartup(context, import("open")
            .then((mod) => mod.default(url))
            .then(() => {
              logger.info(`Opened browser at ${url}`);
            })
            .catch((err) => {
              logger.warn({ err, url }, "Failed to open browser on startup");
            }));
        }
        printStartupBanner({
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

        resolveListen();
      });
    });
  }

  // [checkpoint+graceful shutdown] heartbeatService 는 scheduler 활성 여부와 무관하게 항상 생성한다:
  // SIGTERM/SIGINT 종료 플러시(markRunsShutdownInterrupted)가 이 인스턴스를 필요로 하고,
  // scheduler 가 꺼진 경우에도(이론상 tracked child 없음) 플러시 호출부가 단순해진다.
  const heartbeat = heartbeatService(db);
  context.heartbeat = heartbeat;
  if (config.heartbeatSchedulerEnabled && !runtimeExecutionLifecycle.shutdownState()) {
    const routines = routineService(db as any);
    context.heartbeatScheduler = createHeartbeatScheduler({
      heartbeat,
      routines,
      logger,
      timerIntervalMs: config.heartbeatSchedulerIntervalMs,
      routineIntervalMs: config.heartbeatSchedulerIntervalMs,
    });
    context.heartbeatScheduler.start();
  }
  
  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    if (runtimeExecutionLifecycle.shutdownState()) {
      process.exitCode = 1;
      logger.error({ shutdown: runtimeExecutionLifecycle.shutdownState() },
        "Startup failed during shutdown; preserving the database and unresolved runtime state");
      return;
    }
    process.exit(1);
  });
}
