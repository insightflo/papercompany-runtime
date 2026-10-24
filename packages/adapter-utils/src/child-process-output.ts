import type { Readable } from "node:stream";

type OutputStream = "stdout" | "stderr";
type FlowControl = Pick<Readable, "pause" | "resume">;

/**
 * Captures the existing tail and serializes both pipes in server-observed order.
 * Pausing both pipes bounds pending delivery while an asynchronous sink is busy.
 * Process lifetime, stdin and activity clocks remain with runChildProcess.
 */
export function createChildProcessOutput(opts: {
  stdout: FlowControl | null | undefined;
  stderr: FlowControl | null | undefined;
  appendWithCap: (previous: string, chunk: string) => string;
  onLog: (stream: OutputStream, chunk: string) => Promise<void>;
  onLogError: (err: unknown, stream: OutputStream) => void;
  fatalOnLogError?: boolean;
  terminate: () => void;
}) {
  let stdout = "";
  let stderr = "";
  let logError: Error | null = null;
  let logChain: Promise<void> = Promise.resolve();
  let pending = 0;
  const pipes = [opts.stdout, opts.stderr];

  function accept(stream: OutputStream, chunk: unknown) {
    const text = String(chunk);
    if (stream === "stdout") stdout = opts.appendWithCap(stdout, text);
    else stderr = opts.appendWithCap(stderr, text);

    // Pause synchronously, before another pipe can enqueue unbounded callbacks.
    for (const pipe of pipes) pipe?.pause();
    pending += 1;
    logChain = logChain
      .then(() => opts.onLog(stream, text))
      .catch((err: unknown) => {
        opts.onLogError(err, stream);
        if (!opts.fatalOnLogError || logError) return;
        const message = err instanceof Error ? err.message : String(err);
        logError = new Error(message || `failed to append ${stream} log chunk`);
        opts.terminate();
      })
      .finally(() => {
        pending -= 1;
        // Also resume after failures so termination can finish draining the pipes.
        if (pending === 0) {
          for (const pipe of pipes) pipe?.resume();
        }
      });
  }

  return {
    accept,
    async drain() {
      await logChain;
      if (logError) throw logError;
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}
