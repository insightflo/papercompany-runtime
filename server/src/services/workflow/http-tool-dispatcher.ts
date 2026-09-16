import { Agent, fetch as undiciFetch } from "undici";

/** Node timer upper bound (2^31 - 1); larger delays are clamped to 1ms. */
const TRANSPORT_TIMEOUT_CEILING_MS = 2_147_483_647;

let shared: Agent | undefined;

/**
 * undici — the engine behind Node's global fetch — aborts a request whose
 * response headers have not arrived within its default headersTimeout of
 * 300s, regardless of any AbortSignal or configured tool timeout. Sync
 * tools that compute the entire response before sending headers (e.g. the
 * shorts stage-8 assembly service) legitimately exceed that default while
 * still inside their configured deadline, and died at ~5 minutes with an
 * opaque transport abort (2026-09-16 shorts-assemble incident, three
 * occurrences: tool_progress_execution_failed + remote BrokenPipeError).
 *
 * A single shared dispatcher raises the transport-level header/body waits
 * to the Node timer ceiling, effectively disabling them, so the adapter's
 * own deadline machinery is the sole authority: the no-policy path races
 * the operation against withFixedDeadline(timeoutMs), the progress path
 * against withToolProgress(maxDurationMs) — both abort the request through
 * the same AbortSignal. An unbounded transport wait can therefore never
 * outlive a configured deadline.
 *
 * Callers must use undiciFetch (re-exported) rather than the global fetch
 * so the dispatcher and the fetch implementation always come from the same
 * package instance — global fetch support for the non-standard `dispatcher`
 * init option is not guaranteed across Node/undici versions.
 */
export function httpDispatcher(): Agent {
  if (!shared) {
    shared = new Agent({
      headersTimeout: TRANSPORT_TIMEOUT_CEILING_MS,
      bodyTimeout: TRANSPORT_TIMEOUT_CEILING_MS,
      // Same invariant for the connect phase: the default 10s connectTimeout
      // could cut a long-deadline tool short before its own deadline fires.
      // The deadline machinery's AbortSignal governs every phase, so waiting
      // here cannot outlive a configured deadline.
      connect: { timeout: TRANSPORT_TIMEOUT_CEILING_MS },
    });
  }
  return shared;
}

export { undiciFetch };
