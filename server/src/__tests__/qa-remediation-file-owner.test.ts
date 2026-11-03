// server/src/__tests__/qa-remediation-file-owner.test.ts
//
// C5 — 커널 소유 파일 게시 컴포넌트(qa-remediation-file-owner) 의 실제 프로세스/파일시스템 테스트.
// FS·커널·프로세스 mock 없이 실제 python helper 들을 띄운다. 배타 증명은 양성 lock_wait 이벤트
// 대기(마감 시간은 실패 감지용일 뿐 권한이 아님), 임의 sleep 없음. 각 helper 는 temp/guard 디렉터리
// 정리 전에 종료 관측·정리된다. DB/producer 통합이나 C5 전체 해결을 주장하지 않는다(통합·활성화는
// main 소관 — 여기선 컴포넌트 계약만).

import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QaRemediationFileOwner,
  runGuardedPublication,
  type FileOwnerPublishItem,
  type FileOwnerPublishResult,
} from "../services/workflow/control-flow/qa-remediation-file-owner.js";

const helperPath = fileURLToPath(new URL("../services/workflow/control-flow/qa-remediation-file-owner.py", import.meta.url));
const pythonCommand = "python3";
const BEFORE = "before bytes\n";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const workspaces: string[] = [];
const owners = new Set<{ abort(): Promise<unknown>; close(): Promise<unknown> }>();
const begins: Promise<QaRemediationFileOwner>[] = [];

afterEach(async () => {
  const first = await Promise.allSettled([...owners].map((owner) => owner.abort()));
  owners.clear();
  const failures = first.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "failed to stop an owned file-owner helper");
  for (const result of await Promise.allSettled(begins.splice(0))) if (result.status === "fulfilled") owners.add(result.value);
  const second = await Promise.allSettled([...owners].map((owner) => owner.abort()));
  owners.clear();
  failures.push(...second.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, "failed to stop an owned file-owner helper");
  for (const dir of workspaces.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<{ dir: string; lockRoot: string; file: string }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "c5-owner-")));
  const lockRoot = path.join(dir, "guard-root");
  await mkdir(lockRoot, { mode: 0o700 });
  const file = path.join(dir, "report.md");
  await writeFile(file, BEFORE, { mode: 0o600 });
  workspaces.push(dir);
  return { dir, lockRoot, file };
}

function item(file: string, before: string, after: string): FileOwnerPublishItem {
  return {
    target: file,
    beforeSha256: sha(before),
    beforeSize: Buffer.byteLength(before),
    afterSha256: sha(after),
    afterSize: Buffer.byteLength(after),
    bytesB64: Buffer.from(after, "utf8").toString("base64"),
  };
}

interface EventSink { readonly promise: Promise<string[]>; readonly seen: string[]; push(target: string): void; }
function eventSink(): EventSink {
  const seen: string[] = [];
  let resolve!: (value: string[]) => void;
  const promise = new Promise<string[]>((settled) => { resolve = settled; });
  return { promise, seen, push: (target) => { seen.push(target); resolve(seen); } };
}

const begin = (lockRoot: string, targets: readonly string[], sink?: EventSink, signal?: AbortSignal) => {
  const promise = QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand, helperPath, signal, onEvent: sink ? (event) => sink.push(event.target) : undefined })
    .then((owner) => { owners.add(owner); return owner; });
  begins.push(promise);
  return promise;
};

function probeGuard(lockRoot: string, target: string): number | null {
  const guard = path.join(lockRoot, `c5-${sha(target)}.guard`);
  const probe = spawnSync(pythonCommand, ["-c", "import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry: fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(42)\n", guard], { encoding: "utf8" });
  return probe.status;
}

/** 마감은 실패 감지용일 뿐 — 기다림의 근거는 양성 이벤트 자체다(임의 sleep 아님). */
const waitFor = <T>(promise: Promise<T>, what: string, deadlineMs = 5000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), deadlineMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

/** raw 프로토콜 프로브 — spawn 오류 처리 + stdio close 관측 후 출력 파싱. */
async function raw(lines: readonly string[]): Promise<{ exit: { code: number | null; signal: string | null }; lines: Record<string, unknown>[] }> {
  const child = spawn(pythonCommand, [helperPath], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`raw spawn failed: ${error.message}`)));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { output += chunk; });
  child.stdout!.on("error", (error) => { throw new Error(`raw stdout error: ${error.message}`); });
  for (const line of lines) child.stdin!.write(line);
  const exit = await closed;
  return { exit, lines: output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [] };
}

it("커널 guard: lock_wait 확인 뒤 첫 helper 가 close 까지 배타하고, 이관 후 최신 bytes 로 정착한다", async () => {
  const { dir, lockRoot, file } = await workspace();
  const first = await begin(lockRoot, [file]);
  const waits = eventSink();
  const secondPromise = begin(lockRoot, [file], waits);
  await waitFor(waits.promise, "lock_wait");  // 양성 비차단 경합 신호 — 게시 전에 확보
  const published = await first.publish([item(file, BEFORE, "first applied\n")]);
  expect(published.outcome).toBe("published");
  expect(published.files[0]?.status).toBe("applied");
  expect(published.files[0]?.observedSha256).toBe(sha("first applied\n"));
  expect(await readFile(file, "utf8")).toBe("first applied\n");
  expect((await stat(file)).mode & 0o777).toBe(0o600);  // 원본 mode 보존
  expect(await first.close()).toEqual({ code: 0, signal: null });  // 관측된 정상 종료
  const second = await secondPromise;  // close 이후에만 ready
  expect(waits.seen).toEqual([file]);
  const newer = await second.publish([item(file, "first applied\n", "second newer\n")]);
  expect(newer.outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("second newer\n");
  expect(await second.close()).toEqual({ code: 0, signal: null });
  expect(await readdir(lockRoot)).toHaveLength(1);  // guard 파일은 절대 unlink 되지 않는다
  expect((await readdir(dir)).filter((name) => name.startsWith(".c5pub-"))).toEqual([]);  // temp 잔존물 없음
});

it("자식 실종(SIGKILL)은 guard 를 해제하고 정확한 관측 종료·재획득을 남긴다", async () => {
  const { lockRoot, file } = await workspace();
  const first = await begin(lockRoot, [file]);
  const abort = await first.abort();  // 자기 helper 종료 + 실제 종료 대기
  expect(abort.actualResult).toBe("unknown");  // 미시작 거짓 보고 금지
  expect(abort.exit).toEqual({ code: null, signal: "SIGKILL" });  // 실측 종료, 가공 아님
  const second = await begin(lockRoot, [file]);  // 커널이 guard 를 해제했다
  const result = await second.publish([item(file, BEFORE, "after death\n")]);
  expect(result.outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("after death\n");
  expect(await second.close()).toEqual({ code: 0, signal: null });
});

it("악형 프로토콜 줄은 typed error 응답(id null) 후 비정상 종료로 거부된다", async () => {
  const { lockRoot, file } = await workspace();
  const probe = await raw(["this is not json\n"]);
  expect(probe.exit).toEqual({ code: 2, signal: null });
  expect(probe.lines[probe.lines.length - 1]).toMatchObject({ type: "error", code: "bad_json", id: null });
  void lockRoot; void file;
});

it("요청 id 누락 begin 은 bad_request_id 로 거부된다(오류 응답 id null, exit 2)", async () => {
  const { lockRoot, file } = await workspace();
  const frame = `${JSON.stringify({ v: 1, op: "begin", lockRoot, targets: [file] })}\n`;
  const probe = await raw([frame]);
  expect(probe.exit).toEqual({ code: 2, signal: null });
  expect(probe.lines[probe.lines.length - 1]).toMatchObject({ type: "error", code: "bad_request_id", id: null });
});

it("group/world writable guard 파일(0666)은 unsafe_guard 로 거부된다", async () => {
  const { lockRoot, file } = await workspace();
  const guardPath = path.join(lockRoot, `c5-${sha(file)}.guard`);
  await writeFile(guardPath, "", { mode: 0o600 });
  await chmod(guardPath, 0o666);  // umask 와 무관하게 실제 0666 보장
  await expect(begin(lockRoot, [file])).rejects.toMatchObject({ code: "unsafe_guard" });
});

it("중복 target·범위 밖 item·symlink target/lockRoot 를 거부한다", async () => {
  const { dir, lockRoot, file } = await workspace();
  await expect(begin(lockRoot, [file, file])).rejects.toMatchObject({ code: "duplicate_targets" });
  const owner = await begin(lockRoot, [file]);
  const outOfScope = { ...item(file, BEFORE, "x"), target: path.join(dir, "other.md") };
  const refusal = await owner.publish([outOfScope]).then(
    () => { throw new Error("out-of-scope publication unexpectedly succeeded"); },
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({ code: "item_out_of_scope" });
  const exit = (refusal as { exit?: { code: number | null; signal: string | null } | null }).exit;
  expect(exit).toBeDefined();
  expect(exit).not.toBeNull();  // public rejection includes the observed child exit
  expect(exit?.code !== null || exit?.signal !== null).toBe(true);
  expect(probeGuard(lockRoot, file)).toBe(0);  // real LOCK_NB succeeds before later cleanup
  const real = path.join(dir, "real.md");
  await writeFile(real, "r\n");
  await symlink(real, path.join(dir, "link.md"));
  await expect(begin(lockRoot, [path.join(dir, "link.md")])).rejects.toMatchObject({ code: "alias_refused" });
  await symlink(lockRoot, path.join(dir, "linked-root"));
  await expect(begin(path.join(dir, "linked-root"), [file])).rejects.toMatchObject({ code: "alias_refused" });
});

it("before 불일치는 bytes 를 그대로 두고(held), after 일치만 멱등 skip 한다", async () => {
  const { lockRoot, file } = await workspace();
  const owner = await begin(lockRoot, [file]);
  const wrong = await owner.publish([item(file, "unmatched\n", "never written\n")]);
  expect(wrong.outcome).toBe("held");
  expect(wrong.files[0]?.status).toBe("mismatch_held");
  expect(wrong.files[0]?.observedSha256).toBe(sha(BEFORE));  // 실측 증거
  expect(await readFile(file, "utf8")).toBe(BEFORE);  // 절대 덮어쓰지 않는다
  const good = await owner.publish([item(file, BEFORE, "fixed bytes\n")]);
  expect(good.outcome).toBe("published");
  const again = await owner.publish([item(file, BEFORE, "fixed bytes\n")]);
  expect(again.outcome).toBe("published");
  expect(again.files[0]?.status).toBe("already_applied");  // 보유 lock 안에서만 멱등 skip
  expect(await readFile(file, "utf8")).toBe("fixed bytes\n");
  expect(await owner.close()).toEqual({ code: 0, signal: null });
});

it("guard 획득 후·게시 전 호출자 DB 권한 재검증이 필수다(거부 시 미기록)", async () => {
  const { lockRoot, file } = await workspace();
  let guardHeld = false;
  const denied = await runGuardedPublication({
    lockRoot, targets: [file], pythonCommand, helperPath,
    items: [item(file, BEFORE, "denied write\n")],
    revalidateAuthority: async (context) => { guardHeld = context.guardHeld; return { authorized: false, detail: "reservation lost" }; },
  });
  expect(denied.outcome).toBe("authority_denied");
  expect(guardHeld).toBe(true);  // ready 이후 시점 보장
  expect(await readFile(file, "utf8")).toBe(BEFORE);  // 거부 시 아무 기록 없음
  if (denied.outcome === "authority_denied") expect(denied.helperExit).toEqual({ code: 0, signal: null });
  const granted = await runGuardedPublication({
    lockRoot, targets: [file], pythonCommand, helperPath,
    items: [item(file, BEFORE, "granted write\n")],
    revalidateAuthority: async () => ({ authorized: true }),
  });
  expect(granted.outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("granted write\n");
});

it("abort 시그널은 자기 helper 만 실측 종료시키고 unknown 실제 결과를 돌려준다", async () => {
  const { lockRoot, file } = await workspace();
  const controller = new AbortController();
  const outcome = runGuardedPublication({
    lockRoot, targets: [file], pythonCommand, helperPath, signal: controller.signal,
    items: [item(file, BEFORE, "racing write\n")],
    revalidateAuthority: () => new Promise(() => { controller.abort(); }),  // 재확인 대기 중 abort
  });
  const result = await outcome;
  expect(result.outcome).toBe("aborted");
  if (result.outcome === "aborted") {
    expect(result.actualResult).toBe("unknown");
    expect(result.helperExit).toEqual({ code: null, signal: "SIGKILL" });
  }
  const next = await begin(lockRoot, [file]);  // 죽은 자식의 guard 는 커널이 해제
  expect((await next.publish([item(file, BEFORE, "settled\n")])).outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("settled\n");
  expect(await next.close()).toEqual({ code: 0, signal: null });
});

it("guard 획득 대기 중 abort 되면 begin 은 거부되고 보유자는 영향 없다", async () => {
  const { lockRoot, file } = await workspace();
  const first = await begin(lockRoot, [file]);
  const controller = new AbortController();
  const waits = eventSink();
  const blocked = begin(lockRoot, [file], waits, controller.signal);
  await waitFor(waits.promise, "lock_wait");  // 획득 대기 중임을 양성 확인
  controller.abort();
  await expect(blocked).rejects.toMatchObject({ code: "aborted" });  // 미시작 추론 없는 거부
  expect((await first.publish([item(file, BEFORE, "holder wins\n")])).outcome).toBe("published");
  expect(await first.close()).toEqual({ code: 0, signal: null });
  const third = await begin(lockRoot, [file]);  // 해제된 guard 재획득
  expect((await third.publish([item(file, "holder wins\n", "final\n")])).outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("final\n");
  expect(await third.close()).toEqual({ code: 0, signal: null });
});

it("동시 publish 중복 요청은 pending 대체 없이 거부되고 첫 요청은 완결된다", async () => {
  const { lockRoot, file } = await workspace();
  const owner = await begin(lockRoot, [file]);
  const settled = await Promise.allSettled([
    owner.publish([item(file, BEFORE, "one\n")]),
    owner.publish([item(file, BEFORE, "one\n")]),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<FileOwnerPublishResult>[];
  const rejected = settled.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: "overlapping_request" });
  expect(fulfilled[0]!.value.outcome).toBe("published");
  expect(await readFile(file, "utf8")).toBe("one\n");
  expect(await owner.close()).toEqual({ code: 0, signal: null });  // 거부가 자식을 해치지 않는다
});
