import type { ErrorRequestHandler, NextFunction, Request, RequestHandler } from "express";

export type HttpHandlerLane = "independent" | "callback";

type HandlerKind = "stage" | "terminal" | "error";

type HeldFinalization = {
  requestId: number;
  lane: HttpHandlerLane;
  evidence: unknown;
};

type Ticket = {
  id: number;
  lane: HttpHandlerLane;
  pending: Set<Promise<unknown>>;
  releaseStart: () => void;
  continuation: { resolve: () => void } | null;
  started: boolean;
  terminalStarted: boolean;
  awaitingError: boolean;
  terminalFailed: boolean;
  terminalFailure: unknown;
};

export class HttpHandlerFinalizationHeldError extends Error {
  constructor(readonly heldFinalizations: readonly HeldFinalization[]) {
    super(`HTTP handler finalization is held for ${heldFinalizations.length} request(s)`);
    this.name = "HttpHandlerFinalizationHeldError";
  }
}

export class HttpHandlerTerminalFailureError extends Error {
  constructor(readonly failures: readonly { requestId: number; lane: HttpHandlerLane; error: unknown }[]) {
    super(`HTTP handler terminal failed for ${failures.length} request(s)`);
    this.name = "HttpHandlerTerminalFailureError";
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof Reflect.get(value, "then") === "function";
}

function isForwardedError(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "route" && value !== "router";
}

/** Owns only explicitly admitted callbacks; it does not observe sockets or patch Express. */
export function createHttpHandlerLifetime() {
  const ticketsByRequest = new WeakMap<Request, Ticket>();
  const activeTickets = new Map<number, Ticket>();
  const heldFinalizations: HeldFinalization[] = [];
  let nextRequestId = 1;
  let independentStartsOpen = true;
  let ingressOpen = true;

  function completeIfSettled(ticket: Ticket): void {
    if (!ticket.started || !ticket.terminalStarted || ticket.awaitingError || ticket.terminalFailed || ticket.pending.size > 0) return;
    activeTickets.delete(ticket.id);
  }

  function start(ticket: Ticket): void {
    if (ticket.started) return;
    ticket.started = true;
    ticket.releaseStart();
  }

  function waitForContinuation(ticket: Ticket): void {
    if (ticket.continuation) return;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let tracked!: Promise<void>;
    tracked = waiting.then(() => {
      ticket.pending.delete(tracked);
      ticket.continuation = null;
      completeIfSettled(ticket);
    });
    ticket.continuation = { resolve: release };
    ticket.pending.add(tracked);
  }

  function resumeContinuation(ticket: Ticket): void {
    ticket.continuation?.resolve();
  }

  function beginTerminal(ticket: Ticket, isErrorHandler = false): void {
    start(ticket);
    ticket.terminalStarted = true;
    if (isErrorHandler) ticket.awaitingError = false;
    resumeContinuation(ticket);
  }

  function settleStage(ticket: Ticket, continued: boolean): void {
    if (!continued && !ticket.terminalStarted) ticket.terminalStarted = true;
    completeIfSettled(ticket);
  }

  function observe<T>(
    ticket: Ticket,
    result: PromiseLike<T>,
    kind: HandlerKind,
    continued: () => boolean,
  ): Promise<T> {
    let tracked!: Promise<T>;
    tracked = Promise.resolve(result).then(
      (value) => {
        ticket.pending.delete(tracked);
        if (kind === "stage") settleStage(ticket, continued());
        if (kind === "error") ticket.awaitingError = false;
        completeIfSettled(ticket);
        return value;
      },
      (error: unknown) => {
        ticket.pending.delete(tracked);
        if (kind === "error") {
          ticket.terminalFailed = true;
          ticket.terminalFailure = error;
          ticket.awaitingError = false;
        } else {
          ticket.awaitingError = true;
          waitForContinuation(ticket);
        }
        completeIfSettled(ticket);
        throw error;
      },
    );
    ticket.pending.add(tracked);
    return tracked;
  }

  function wrapRequestHandler(handler: RequestHandler, kind: "stage" | "terminal"): RequestHandler {
    return function wrappedRequestHandler(this: unknown, req, res, next) {
      const ticket = ticketsByRequest.get(req);
      if (!ticket) return handler.call(this, req, res, next);
      const activeTicket = ticket;
      start(ticket);
      if (kind === "terminal") beginTerminal(ticket);

      let continued = false;
      function trackedNext(error?: unknown): void;
      function trackedNext(deferToNext: "router"): void;
      function trackedNext(deferToNext: "route"): void;
      function trackedNext(...args: [unknown?]): void {
        continued = true;
        waitForContinuation(activeTicket);
        const error = args[0];
        if (isForwardedError(error)) activeTicket.awaitingError = true;
        if (args.length === 0) return next();
        if (error === "router") return next("router");
        if (error === "route") return next("route");
        return next(error);
      }

      let result: unknown;
      try {
        result = handler.call(this, req, res, trackedNext);
      } catch (error) {
        if (kind === "stage") {
          ticket.awaitingError = true;
          waitForContinuation(ticket);
        }
        if (kind === "terminal") {
          ticket.awaitingError = true;
          waitForContinuation(ticket);
        }
        completeIfSettled(ticket);
        throw error;
      }

      if (isPromiseLike(result)) {
        return observe(ticket, result, kind, () => continued);
      }
      if (kind === "stage") settleStage(ticket, continued);
      completeIfSettled(ticket);
      return result;
    };
  }

  return {
    /** Synchronous admission; callers must invoke the wrapped stage or terminal next. */
    enter(req: Request, lane: HttpHandlerLane): boolean {
      const existing = ticketsByRequest.get(req);
      if (existing) {
        if (existing.lane !== lane) throw new Error("HTTP request already has a ticket in a different lane");
        return true;
      }
      if (!ingressOpen || (lane === "independent" && !independentStartsOpen)) return false;

      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const ticket: Ticket = {
        id: nextRequestId++, lane, pending: new Set(), releaseStart, continuation: null,
        started: false, terminalStarted: false, awaitingError: false, terminalFailed: false, terminalFailure: undefined,
      };
      let startWait!: Promise<void>;
      startWait = startGate.then(() => {
        ticket.pending.delete(startWait);
        completeIfSettled(ticket);
      });
      ticket.pending.add(startWait);
      ticketsByRequest.set(req, ticket);
      activeTickets.set(ticket.id, ticket);
      return true;
    },

    wrapStage(handler: RequestHandler): RequestHandler {
      return wrapRequestHandler(handler, "stage");
    },

    wrapTerminal(handler: RequestHandler): RequestHandler {
      return wrapRequestHandler(handler, "terminal");
    },

    wrapError(handler: ErrorRequestHandler): ErrorRequestHandler {
      return function wrappedErrorHandler(this: unknown, error, req, res, next) {
        const ticket = ticketsByRequest.get(req);
        if (!ticket) return handler.call(this, error, req, res, next);
        beginTerminal(ticket, true);
        let result: unknown;
        try {
          result = handler.call(this, error, req, res, next);
        } catch (terminalError) {
          ticket.terminalFailed = true;
          ticket.terminalFailure = terminalError;
          ticket.awaitingError = false;
          completeIfSettled(ticket);
          throw terminalError;
        }
        if (isPromiseLike(result)) return observe(ticket, result, "error", () => false);
        ticket.awaitingError = false;
        completeIfSettled(ticket);
        return result;
      };
    },

    stopIndependentStarts(): void {
      independentStartsOpen = false;
    },

    sealIngress(): void {
      independentStartsOpen = false;
      ingressOpen = false;
    },

    /** Omit lane to join all tickets; callback tickets remain admissible until sealIngress(). */
    async drain(lane?: HttpHandlerLane): Promise<void> {
      const matchesLane = (ticket: Ticket) => lane === undefined || ticket.lane === lane;
      while (true) {
        const tickets = [...activeTickets.values()].filter(matchesLane);
        if (tickets.length === 0) break;
        const pending = [...new Set(tickets.flatMap((ticket) => [...ticket.pending]))];
        if (pending.length > 0) {
          await Promise.allSettled(pending);
          continue;
        }
        for (const ticket of tickets) completeIfSettled(ticket);
        const remaining = [...activeTickets.values()].filter(matchesLane);
        if (remaining.length === 0) break;
        const failed = remaining.filter((ticket) => ticket.terminalFailed).map((ticket) => ({
          requestId: ticket.id, lane: ticket.lane, error: ticket.terminalFailure,
        }));
        if (failed.length > 0) throw new HttpHandlerTerminalFailureError(failed);
        throw new Error("HTTP handler ticket remains active without joinable work");
      }
      const held = heldFinalizations.filter((hold) => lane === undefined || hold.lane === lane);
      if (held.length > 0) throw new HttpHandlerFinalizationHeldError(held);
    },

    /** Sticky by design: this primitive has no release path without durable readback. */
    holdFinalization(req: Request, evidence: unknown): void {
      const ticket = ticketsByRequest.get(req);
      if (!ticket) throw new Error("Cannot hold HTTP finalization without an admitted request");
      heldFinalizations.push({ requestId: ticket.id, lane: ticket.lane, evidence });
    },
  };
}
