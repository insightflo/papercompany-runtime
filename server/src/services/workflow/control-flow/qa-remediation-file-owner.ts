// server/src/services/workflow/control-flow/qa-remediation-file-owner.ts
//
// [purpose] C5 — qa remediation 게시의 '커널 소유' 배타 기록 helper(python) 를 spawn 하는 TS 래퍼.
//   helper 가 guard flock(LOCK_EX) 을 실제 보유한 뒤(ready)에만 부모가 DB 권한을 재확인하고, 승인될
//   때만 publish 한다. 대상 파일의 모든 실제 IO 는 helper 프로세스 안에서 일어난다.
// [authority] 문법·프로토콜·해시가 권한을 부여하지 않는다. 게시 통합 진입점 runGuardedPublication 은
//   guard 획득 후·게시 전 호출자 재검증 revalidateAuthority 를 필수로 요구하고 거부 시 미기록 정리한다.
//   실제 DB 대조는 호출자(B2 root) 소관 — 이 파일은 DB 에 접근하지 않는다(미통합·미활성).
// [safety] 모든 오류 경로는 자기 자식을 정리(kill→실제 종료 관측→스트림 close)한 뒤에만 공개 거부한다.
//   spawn 실패는 exit waiter 를 null 로 확정(가짜 exit 0 금지). 요청 중복은 pending 대체 없이 거부.
//   abort 는 spawn/acquisition/revalidation/publish 어디서든 자기 자식만 종료하며 실측 종료와
//   actualResult:"unknown" 만 돌려준다(미시작 추론 금지, 타임아웃/나이 권한 금지). lockRoot/
//   pythonCommand/helperPath 는 모두 명시적 인수 — 기본값·환경설정 없음. helper .py 는 현재 build
//   패키징에 포함되지 않는다(onboarding/flowmap asset 만 복사) — 패키징은 main 통합 단계 과제.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { QA_REMEDIATION_MAX_FILE_BYTES } from "./qa-remediation-contract.js";

export const FILE_OWNER_PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_STATUSES = new Set(["applied", "already_applied", "held", "mismatch_held", "io_error", "not_attempted"]);

export interface FileOwnerBeginInput {
  readonly lockRoot: string;
  readonly targets: readonly string[];
  readonly pythonCommand: string;
  readonly helperPath: string;
  readonly onEvent?: (event: { readonly type: "lock_wait"; readonly target: string }) => void;
  readonly signal?: AbortSignal;
}
export interface FileOwnerPublishItem {
  readonly target: string;
  readonly beforeSha256: string;
  readonly beforeSize: number;
  readonly afterSha256: string;
  readonly afterSize: number;
  readonly bytesB64: string;
}
export type FileOwnerFileStatus = "applied" | "already_applied" | "held" | "mismatch_held" | "io_error" | "not_attempted";
export interface FileOwnerFileResult {
  readonly target: string;
  readonly status: FileOwnerFileStatus;
  readonly detail: string;
  readonly observedSha256?: string | null;
  readonly observedSize?: number | null;
}
export type FileOwnerPublishOutcome = "published" | "held" | "io_error";
export interface FileOwnerPublishResult {
  readonly outcome: FileOwnerPublishOutcome;
  readonly files: readonly FileOwnerFileResult[];
  readonly detail: string;
}
export interface FileOwnerExit { readonly code: number | null; readonly signal: string | null; }

export class QaRemediationFileOwnerError extends Error {
  constructor(message: string, readonly code?: string, exit?: FileOwnerExit | null) {
    super(message);
    this.name = "QaRemediationFileOwnerError";
    this.exit = exit;
  }

  exit: FileOwnerExit | null | undefined;
}

interface Reply { readonly v: number; readonly id?: string; readonly type?: string; readonly [key: string]: unknown; }
interface Pending { readonly id: string; readonly type: string; resolve(reply: Reply): void; reject(error: Error): void; }

export class QaRemediationFileOwner {
  private buffer = "";
  private pending: Pending | null = null;
  private exitInfo: FileOwnerExit | null = null;
  private spawnFailed = false;
  private terminating: QaRemediationFileOwnerError | null = null;  // 자발적 종료 중 — exit 이벤트가 이유를 덮어쓰지 못하게
  private termination: Promise<FileOwnerExit | null> | null = null;
  private readonly exitWaiters: ((info: FileOwnerExit | null) => void)[] = [];
  private readonly heldTargets: readonly string[];

  private constructor(private readonly child: ChildProcess, private readonly onEvent: FileOwnerBeginInput["onEvent"], targets: readonly string[]) {
    this.heldTargets = [...targets];
  }

  /** 보유 중인 guard 대상(정렬된 begin targets 사본). */
  targets(): readonly string[] { return this.heldTargets; }

  static async begin(input: FileOwnerBeginInput): Promise<QaRemediationFileOwner> {
    if (input.signal?.aborted) throw new QaRemediationFileOwnerError("signal already aborted before begin", "aborted", null);
    if (!input.lockRoot || !Array.isArray(input.targets) || input.targets.length === 0 || !input.pythonCommand || !input.helperPath) {
      throw new QaRemediationFileOwnerError("lockRoot, targets, pythonCommand, helperPath are all required", "bad_begin", null);
    }
    let abortedEarly = false;  // spawn 전 신호 등록 — 획득 중 abort 도 놓치지 않는다
    const early = () => { abortedEarly = true; };
    input.signal?.addEventListener("abort", early, { once: true });
    const child = spawn(input.pythonCommand, [input.helperPath], { stdio: ["pipe", "pipe", "pipe"] });
    const owner = new QaRemediationFileOwner(child, input.onEvent, input.targets);
    const onAbort = () => { void owner.killAndFail(new QaRemediationFileOwnerError("helper aborted during begin", "aborted")); };
    input.signal?.removeEventListener("abort", early);
    if (abortedEarly || input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      owner.spawnFailed = true;
      for (const waiter of owner.exitWaiters.splice(0)) waiter(null);  // 가짜 exit 없이 null 확정
      owner.destroyStreams();
      owner.failPending(new QaRemediationFileOwnerError(`helper spawn error: ${error.message}`, "spawn_error", null));
    });
    child.on("exit", (code, signal) => {
      owner.exitInfo = { code, signal };
      for (const waiter of owner.exitWaiters.splice(0)) waiter(owner.exitInfo);
      owner.destroyStreams();
      if (!owner.terminating) owner.failPending(new QaRemediationFileOwnerError(`helper exited before reply (code=${code}, signal=${signal})`, "helper_exit", owner.exitInfo));
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => owner.feed(chunk));
    child.stdout!.on("end", () => { if (owner.pending && !owner.exitInfo) void owner.killAndFail(new QaRemediationFileOwnerError("helper stdout ended before reply", "stdout_eof")); });
    const surface = (where: string) => (error: Error) => { void owner.killAndFail(new QaRemediationFileOwnerError(`helper ${where} stream error: ${error.message}`, "stream_error")); };
    child.stdin!.on("error", surface("stdin"));
    child.stdout!.on("error", surface("stdout"));
    child.stderr!.setEncoding("utf8");
    let stderrSeen = "";
    child.stderr!.on("data", (chunk: string) => { stderrSeen += chunk; if (stderrSeen.length > MAX_LINE_BYTES) void owner.killAndFail(new QaRemediationFileOwnerError("helper stderr exceeded bound", "stderr_overflow")); });
    child.stderr!.on("error", surface("stderr"));
    try {
      owner.verifyReady(await owner.request("begin", { lockRoot: input.lockRoot, targets: [...input.targets] }, "ready"));
      return owner;
    } catch (error) {
      const reason = error instanceof QaRemediationFileOwnerError ? error : new QaRemediationFileOwnerError(`begin failed: ${String(error)}`, "begin_failed");
      let exit: FileOwnerExit | null;
      try {
        exit = await owner.cleanup();
      } catch (cleanupError) {
        throw new AggregateError([reason, cleanupError], "helper begin failed and owned-child cleanup also failed");
      }
      owner.failPending(new QaRemediationFileOwnerError(reason.message, reason.code, exit));
      throw reason.exit === undefined ? new QaRemediationFileOwnerError(reason.message, reason.code, exit) : reason;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** ready 대상 목록이 요청한 targets 의 정렬 집합과 정확 일치하는가. */
  private verifyReady(ready: Reply): void {
    const expected = [...this.heldTargets].sort();
    const targets = ready.targets;
    if (!Array.isArray(targets) || targets.length !== expected.length || !targets.every((t, i) => t === expected[i])) {
      throw new QaRemediationFileOwnerError("ready reply target set does not match the requested targets", "protocol_mismatch");
    }
  }

  async publish(items: readonly FileOwnerPublishItem[]): Promise<FileOwnerPublishResult> {
    if (!Array.isArray(items) || items.length === 0) throw new QaRemediationFileOwnerError("publish requires a non-empty items list", "bad_items");
    for (const entry of items) {
      if (Buffer.byteLength(entry.bytesB64, "base64") > QA_REMEDIATION_MAX_FILE_BYTES) {
        throw new QaRemediationFileOwnerError(`desired bytes exceed file cap for ${entry.target}`, "bytes_over_cap");
      }
    }
    const requested = items.map(({ target, afterSha256, afterSize }) => ({ target, afterSha256, afterSize }));
    const reply = await this.request("publish", { items }, "publish_result") as Reply;
    const failSchema = async (detail: string): Promise<never> => {
      const mismatch = new QaRemediationFileOwnerError(detail, "protocol_mismatch");
      try {
        const exit = await this.cleanup();
        throw new QaRemediationFileOwnerError(`${detail} (helper exit code=${exit?.code ?? null}, signal=${exit?.signal ?? null})`, "protocol_mismatch", exit);
      } catch (error) {
        if (error instanceof QaRemediationFileOwnerError && error.code === "protocol_mismatch") throw error;
        throw new AggregateError([mismatch, error], "protocol mismatch and owned-child cleanup also failed");
      }
    };
    const outcome = reply.outcome as FileOwnerPublishOutcome;
    if (outcome !== "published" && outcome !== "held" && outcome !== "io_error") return await failSchema(`unknown publish outcome: ${String(reply.outcome)}`);
    const rawFiles = reply.files;
    if (!Array.isArray(rawFiles) || rawFiles.length !== items.length) return await failSchema("publish reply does not cover the exact item set");
    const rows: FileOwnerFileResult[] = [];
    for (const file of rawFiles as readonly Record<string, unknown>[]) {
      const { target, status, detail, observedSha256, observedSize } = file ?? {};
      if (typeof target !== "string" || typeof status !== "string" || !FILE_STATUSES.has(status) || typeof detail !== "string"
        || (observedSha256 != null && (typeof observedSha256 !== "string" || !HEX64.test(observedSha256)))
        || (observedSize != null && (typeof observedSize !== "number" || !Number.isInteger(observedSize) || observedSize < 0))) {
        return await failSchema("malformed publish result row");
      }
      rows.push({ target, status: status as FileOwnerFileStatus, detail, observedSha256: observedSha256 as string | null | undefined, observedSize: observedSize as number | null | undefined });
    }
    if (!rows.every((row, index) => row.target === requested[index]!.target)) return await failSchema("publish reply does not cover the exact ordered item targets");
    if (outcome === "published" && !rows.every((row, index) => {
      const request = requested[index]!;
      return (row.status === "applied" || row.status === "already_applied")
        && row.observedSha256 === request.afterSha256 && row.observedSize === request.afterSize;
    })) return await failSchema("published reply rows do not match the requested after identities");
    return { outcome, files: rows, detail: typeof reply.detail === "string" ? reply.detail : "" };
  }

  async close(): Promise<FileOwnerExit | null> {
    if (!this.exitInfo && !this.spawnFailed) {
      try {
        await this.request("close", {}, "closed");
      } catch (error) {
        if (!this.exitInfo && !this.spawnFailed) throw error;
      }
      if (!this.child.stdin!.destroyed) this.child.stdin!.end();
    }
    const exit = await this.awaitExit();
    this.destroyStreams();
    return exit;
  }

  /** 자기 helper 종료 — 실제 종료 관측 후 unknown 실제 결과 반환(미시작 거짓 보고 금지). */
  async abort(): Promise<{ readonly exit: FileOwnerExit | null; readonly actualResult: "unknown" }> {
    const exit = await this.cleanup();
    return { exit, actualResult: "unknown" };
  }

  async awaitExit(): Promise<FileOwnerExit | null> {
    if (this.exitInfo || this.spawnFailed) return this.exitInfo;
    return await new Promise<FileOwnerExit | null>((resolve) => { this.exitWaiters.push(resolve); });
  }

  private async request(op: string, extra: Record<string, unknown>, expectType: string): Promise<Reply> {
    if (this.pending) throw new QaRemediationFileOwnerError("overlapping request rejected before replacing the pending request", "overlapping_request");
    if (this.exitInfo) throw new QaRemediationFileOwnerError(`helper already exited (code=${this.exitInfo.code}, signal=${this.exitInfo.signal})`, "helper_exit", this.exitInfo);
    const id = randomUUID();
    const line = `${JSON.stringify({ v: FILE_OWNER_PROTOCOL_VERSION, id, op, ...extra })}\n`;
    if (line.length > MAX_LINE_BYTES) throw new QaRemediationFileOwnerError("request exceeds frame cap", "line_too_long");
    const waiter = new Promise<Reply>((resolve, reject) => { this.pending = { id, type: expectType, resolve, reject }; });
    this.child.stdin!.write(line, (error) => {
      if (error) void this.killAndFail(new QaRemediationFileOwnerError(`helper stdin write failed: ${error.message}`, "stdin_write"));
    });
    return await waiter;
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      void this.killAndFail(new QaRemediationFileOwnerError("helper output exceeds frame cap", "line_too_long"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (raw) this.handleLine(raw);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(raw: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(raw) as Reply;
    } catch {
      void this.killAndFail(new QaRemediationFileOwnerError("helper sent non-JSON", "bad_json"));
      return;
    }
    if (reply?.v !== FILE_OWNER_PROTOCOL_VERSION || typeof reply.type !== "string") {
      void this.killAndFail(new QaRemediationFileOwnerError("helper sent unknown protocol frame", "bad_version"));
      return;
    }
    if (reply.type === "lock_wait") {
      this.onEvent?.({ type: "lock_wait", target: String(reply.target) });
      return;
    }
    const pending = this.pending;
    if (reply.type === "error") {
      if (pending && reply.id === pending.id) {  // correlated refusal is not an exit receipt
        void this.killAndFail(new QaRemediationFileOwnerError(`helper refused: ${String(reply.code)}: ${String(reply.message)}`, reply.code as string | undefined));
        return;
      }
      void this.killAndFail(new QaRemediationFileOwnerError("helper error reply does not correlate the pending request", "protocol_mismatch"));
      return;
    }
    if (!pending || reply.id !== pending.id || reply.type !== pending.type) {
      void this.killAndFail(new QaRemediationFileOwnerError("helper reply does not correlate the pending request", "protocol_mismatch"));
      return;
    }
    this.pending = null;
    pending.resolve(reply);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  /** 정리 전용 — kill(필요시)·실제 종료 대기·스트림 close. 정리 실패를 삼키지 않고 관측 가능하게 둔다. */
  private async cleanup(): Promise<FileOwnerExit | null> {
    let killError: unknown;
    if (!this.exitInfo && !this.spawnFailed) {
      try {
        this.child.kill("SIGKILL");
      } catch (error) {
        killError = error;
      }
    }
    const exit = await this.awaitExit();
    this.destroyStreams();
    if (killError) throw new QaRemediationFileOwnerError(`helper kill failed before observed exit: ${String(killError)}`, "kill_failed", exit);
    return exit;
  }

  /** 자기 자식 정리 후에만 공개 거부 — 정리 완료 전 요청 거부 없음. */
  private async killAndFail(error: QaRemediationFileOwnerError): Promise<void> {
    this.terminating ??= error;
    this.termination ??= this.cleanup();
    try {
      const exit = await this.termination;
      this.failPending(new QaRemediationFileOwnerError(this.terminating.message, this.terminating.code, exit));
    } catch (cleanupError) {
      this.failPending(new AggregateError([this.terminating, cleanupError], "helper failed and owned-child cleanup also failed"));
    }
  }

  private destroyStreams(): void {
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      if (stream && !stream.destroyed) stream.destroy();
    }
  }
}

export interface GuardedPublicationInput extends FileOwnerBeginInput {
  readonly items: readonly FileOwnerPublishItem[];
  /** [필수 — C5] guard 획득(ready) 후·게시 전 현재 DB 권한 재확인. 이 콜백 승인 없이는 게시가 없다. */
  readonly revalidateAuthority: (context: { readonly targets: readonly string[]; readonly guardHeld: true }) =>
    Promise<{ readonly authorized: boolean; readonly detail?: string }>;
}

export type GuardedPublicationOutcome =
  | ({ readonly outcome: FileOwnerPublishOutcome; readonly files: readonly FileOwnerFileResult[]; readonly detail: string; readonly helperExit: FileOwnerExit | null })
  | { readonly outcome: "authority_denied"; readonly detail: string; readonly helperExit: FileOwnerExit | null }
  | { readonly outcome: "aborted"; readonly actualResult: "unknown"; readonly helperExit: FileOwnerExit | null };

const abortedOutcome = (exit: FileOwnerExit | null): GuardedPublicationOutcome => ({ outcome: "aborted", actualResult: "unknown", helperExit: exit });

/** 통합 진입점 — guard 획득 → (lock 보유 중) 호출자 DB 권한 재확인 → 승인 시에만 게시 → 정리. */
export async function runGuardedPublication(input: GuardedPublicationInput): Promise<GuardedPublicationOutcome> {
  const signal = input.signal;
  if (signal?.aborted) return abortedOutcome(null);  // 자식이 없다 — 관측 종료도 없다(가공 금지)
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<true>((resolve) => { if (!signal) return; onAbort = () => resolve(true); signal.addEventListener("abort", onAbort, { once: true }); });
  const settle = <T>(work: Promise<T>): Promise<T | null> => {
    work.catch(() => undefined);  // race 에서 진 요청의 거부도 미처리 거부로 남기지 않는다
    return Promise.race([work, aborted.then(() => null)]);
  };
  let owner: QaRemediationFileOwner | null = null;
  try {
    try {
      owner = await QaRemediationFileOwner.begin(input);
    } catch (error) {
      if (signal?.aborted) return abortedOutcome(error instanceof QaRemediationFileOwnerError ? (error.exit ?? null) : null);
      throw error;
    }
    const acquired = owner;
    if (!acquired) throw new Error("file-owner begin returned without an acquired owner");
    const authority = await settle(input.revalidateAuthority({ targets: acquired.targets(), guardHeld: true }));
    if (authority === null) {
      const exit = (await acquired.abort()).exit;
      owner = null;
      return abortedOutcome(exit);
    }
    if (!authority.authorized) {
      const helperExit = await acquired.close();
      owner = null;
      return { outcome: "authority_denied", detail: authority.detail ?? "caller authority revalidation denied publication", helperExit };
    }
    const result = await settle(acquired.publish(input.items));
    if (result === null) {
      const exit = (await acquired.abort()).exit;
      owner = null;
      return abortedOutcome(exit);
    }
    const exit = await acquired.close();
    owner = null;
    return { outcome: result.outcome, files: result.files, detail: result.detail, helperExit: exit };
  } catch (error) {
    if (owner) {
      try {
        const exit = (await owner.abort()).exit;
        if (error instanceof QaRemediationFileOwnerError && error.exit == null) error.exit = exit;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "publication failed and owned-child cleanup also failed");
      }
    }
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
