import { EventEmitter } from "node:events";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpHandlerLifetime,
  HttpHandlerFinalizationHeldError,
} from "../services/http-handler-lifetime.js";

function request(): Request {
  return new EventEmitter() as unknown as Request;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function next(fn: (error?: unknown) => void = () => undefined): NextFunction {
  return fn as NextFunction;
}

function response(): Response {
  return new EventEmitter() as unknown as Response;
}

const forwardedError = new Error("forwarded error");
const nextForwardingCases: Array<{
  label: string;
  invoke: (callNext: NextFunction) => void;
  args: unknown[];
}> = [
  { label: "without arguments", invoke: (callNext) => callNext(), args: [] },
  { label: "with an error", invoke: (callNext) => callNext(forwardedError), args: [forwardedError] },
  { label: "to the next route", invoke: (callNext) => callNext("route"), args: ["route"] },
  { label: "to the next router", invoke: (callNext) => callNext("router"), args: ["router"] },
];

describe("HTTP handler lifetime", () => {
  it("joins an auth stage when next(error) reaches the error handler first", async () => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const authError = new Error("unauthorized before start");
    const authGate = deferred<string>();
    const authReceiver = { name: "auth" };
    const errorReceiver = { name: "error-handler" };
    const errorVisits: unknown[] = [];
    expect(lifetime.enter(req, "independent")).toBe(true);

    const errorHandler: ErrorRequestHandler = lifetime.wrapError(function (this: unknown, error, gotReq, gotRes) {
      expect(this).toBe(errorReceiver);
      expect(gotReq).toBe(req);
      expect(gotRes).toBe(res);
      errorVisits.push(error);
    });
    const forwarded = vi.fn((error?: unknown) => {
      errorHandler.call(errorReceiver, error, req, res, next());
    });
    const auth = lifetime.wrapStage(function (this: unknown, gotReq, gotRes, callNext) {
      expect(this).toBe(authReceiver);
      expect(gotReq).toBe(req);
      expect(gotRes).toBe(res);
      callNext(authError);
      return authGate.promise;
    });

    const authResult = auth.call(authReceiver, req, res, next(forwarded)) as Promise<string>;
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(errorVisits).toEqual([authError]);
    let drained = false;
    const drain = lifetime.drain("independent").then(() => { drained = true; }, () => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    authGate.resolve("auth continuation settled");
    await expect(authResult).resolves.toBe("auth continuation settled");
    await drain;
    expect(drained).toBe(true);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(errorVisits).toEqual([authError]);
  });

  it("keeps the original terminal promise through request and response close events", async () => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const resultGate = deferred<{ output: string }>();
    expect(lifetime.enter(req, "independent")).toBe(true);
    const terminal = lifetime.wrapTerminal(() => resultGate.promise);
    const original = terminal(req, res, next()) as Promise<{ output: string }>;
    const drain = lifetime.drain("independent");

    req.emit("aborted");
    req.emit("close");
    res.emit("finish");
    res.emit("close");
    let drained = false;
    void drain.then(() => { drained = true; }, () => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    const actual = { output: "original result" };
    resultGate.resolve(actual);
    await expect(original).resolves.toBe(actual);
    await drain;
    expect(drained).toBe(true);
  });

  it("preserves normal terminal fulfillment", async () => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const receiver = { name: "route" };
    const actual = { status: 200, body: { ok: true } };
    expect(lifetime.enter(req, "independent")).toBe(true);
    const terminal = lifetime.wrapTerminal(function (this: unknown, gotReq, gotRes, gotNext) {
      expect(this).toBe(receiver);
      expect(gotReq).toBe(req);
      expect(gotRes).toBe(res);
      expect(gotNext).toBeDefined();
      return Promise.resolve(actual);
    });

    const result = terminal.call(receiver, req, res, next()) as Promise<typeof actual>;
    await expect(result).resolves.toBe(actual);
    await expect(lifetime.drain()).resolves.toBeUndefined();
  });

  it.each(nextForwardingCases)("forwards next() $label unchanged", async ({ invoke, args }) => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const forwarded: unknown[][] = [];
    expect(lifetime.enter(req, "independent")).toBe(true);

    const terminal = lifetime.wrapTerminal(() => undefined);
    const errorHandler = lifetime.wrapError(() => undefined);
    const nextHandler: NextFunction = (...nextArgs: unknown[]) => {
      forwarded.push(nextArgs);
      const value = nextArgs[0];
      if (nextArgs.length === 1 && value !== undefined && value !== "route" && value !== "router") {
        errorHandler(value, req, res, next());
      } else {
        terminal(req, res, next());
      }
    };
    const stage = lifetime.wrapStage((_req, _res, callNext) => invoke(callNext));

    stage(req, res, nextHandler);
    await expect(lifetime.drain()).resolves.toBeUndefined();
    expect(forwarded).toEqual([args]);
  });

  it("settles a known pre-start auth rejection after its error handler finishes", async () => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const authError = new Error("invalid credential");
    const handled: unknown[] = [];
    expect(lifetime.enter(req, "independent")).toBe(true);
    const errorHandler = lifetime.wrapError(((error: unknown) => { handled.push(error); }) as ErrorRequestHandler);
    const errorNext = vi.fn((error?: unknown) => errorHandler(error, req, res, next()));
    const auth = lifetime.wrapStage(() => Promise.reject(authError));
    const original = auth(req, res, next(errorNext)) as Promise<unknown>;

    await expect(original).rejects.toBe(authError);
    errorNext(authError);
    await expect(lifetime.drain()).resolves.toBeUndefined();
    expect(errorNext).toHaveBeenCalledTimes(1);
    expect(handled).toEqual([authError]);
  });

  it("admits late callback work after start stop and seals it before the final drain", async () => {
    const lifetime = createHttpHandlerLifetime();
    lifetime.stopIndependentStarts();
    expect(lifetime.enter(request(), "independent")).toBe(false);

    const callbackReq = request();
    const callbackRes = response();
    const callbackGate = deferred<string>();
    expect(lifetime.enter(callbackReq, "callback")).toBe(true);
    const callback = lifetime.wrapTerminal(() => callbackGate.promise);
    const callbackResult = callback(callbackReq, callbackRes, next()) as Promise<string>;
    await expect(lifetime.drain("independent")).resolves.toBeUndefined();
    const callbackDrain = lifetime.drain("callback");
    let callbackDrained = false;
    void callbackDrain.then(() => { callbackDrained = true; }, () => { callbackDrained = true; });
    await Promise.resolve();
    expect(callbackDrained).toBe(false);

    lifetime.sealIngress();
    expect(lifetime.enter(request(), "callback")).toBe(false);
    callbackGate.resolve("callback committed");
    await expect(callbackResult).resolves.toBe("callback committed");
    await callbackDrain;
    await expect(lifetime.drain()).resolves.toBeUndefined();
  });

  it("keeps held finalization evidence sticky across active removal and repeated drains", async () => {
    const lifetime = createHttpHandlerLifetime();
    const req = request();
    const res = response();
    const resultGate = deferred<{ stdout: string }>();
    const actual = { stdout: "bytes from the actual" };
    const evidence = { receiptId: "receipt-1", result: actual };
    expect(lifetime.enter(req, "independent")).toBe(true);
    const terminal = lifetime.wrapTerminal(() => resultGate.promise);
    const original = terminal(req, res, next()) as Promise<typeof actual>;
    lifetime.holdFinalization(req, evidence);

    const firstDrain = lifetime.drain();
    let drained = false;
    void firstDrain.catch(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    resultGate.resolve(actual);
    await expect(original).resolves.toBe(actual);

    let firstError: unknown;
    try {
      await firstDrain;
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(HttpHandlerFinalizationHeldError);
    expect((firstError as HttpHandlerFinalizationHeldError).heldFinalizations[0]?.evidence).toBe(evidence);

    let repeatedError: unknown;
    try {
      await lifetime.drain();
    } catch (error) {
      repeatedError = error;
    }
    expect(repeatedError).toBeInstanceOf(HttpHandlerFinalizationHeldError);
    expect((repeatedError as HttpHandlerFinalizationHeldError).heldFinalizations[0]?.evidence).toBe(evidence);
  });
});
