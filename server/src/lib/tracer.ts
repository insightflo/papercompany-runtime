/**
 * OpenTelemetry tracer helper.
 *
 * Provides a named tracer for the paperclip server and a `withSpan` utility
 * that wraps async work in a span, recording errors and setting status.
 *
 * If no OTel SDK is configured (no exporter), spans are no-ops via the
 * global ProxyTracer — so instrumentation is always safe to call.
 */

import { trace, SpanStatusCode, type Span, type Attributes } from "@opentelemetry/api";

const TRACER_NAME = "paperclipai-server";

export const tracer = trace.getTracer(TRACER_NAME);

/**
 * Execute `fn` inside a new span named `spanName`.
 *
 * - On success: ends the span with OK status.
 * - On error: records the exception, sets ERROR status, then re-throws.
 *
 * @param spanName  Dot-notation name, e.g. "worktree.checkAction"
 * @param attrs     Initial span attributes
 * @param fn        Async work to wrap
 */
export async function withSpan<T>(
  spanName: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(spanName, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
