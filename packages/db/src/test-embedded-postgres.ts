import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

// embedded-postgres stop() waits for an 'exit' event that never fires when the child
// already exited or SIGINT stalls, deadlocking test cleanup; bound it and escalate.
async function stopEmbeddedPostgresSafely(instance: EmbeddedPostgresInstance): Promise<void> {
  const proc = (instance as unknown as { process?: import("node:child_process").ChildProcess }).process;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      instance.stop().catch(() => {}),
      new Promise<void>((resolve) => {
        forceTimer = setTimeout(() => {
          try { proc.kill("SIGQUIT"); } catch {}
          killTimer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch {}
            resolve();
          }, 500);
          killTimer.unref?.();
        }, 5_000);
        forceTimer.unref?.();
      }),
    ]);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    if (killTimer) clearTimeout(killTimer);
  }
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-postgres-probe-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error),
    };
  } finally {
    await stopEmbeddedPostgresSafely(instance);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  try {
    await instance.initialise();
    await instance.start();

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await stopEmbeddedPostgresSafely(instance);
        fs.rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopEmbeddedPostgresSafely(instance);
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
