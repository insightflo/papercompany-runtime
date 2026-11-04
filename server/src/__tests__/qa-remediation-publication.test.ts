// server/src/__tests__/qa-remediation-publication.test.ts
//
// Stage B2a(C1) — 원자적 게시 helper 의 실제 파일시스템 focused 테스트. 가짜 FS mock 없이 임시 소유
// 경로(mac realpath 정규화 포함)에서 preflight 홀드·부분 복구·원자 기록·mode 보존·temp 정리·alias
// 거부·미소유 잔존물 보존·디렉터리 fsync 내구성 장범을 검증한다. DB 예약/잠금/완료 tx/wake 통합과
// 대형 검사는 B2 root·main 소관(여기서 다루지 않는다).

import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { QaRemediationFileOwner } from "../services/workflow/control-flow/qa-remediation-file-owner.js";
import {
  publishQaRemediationPreparation,
  type QaRemediationPublicationAuthority,
} from "../services/workflow/control-flow/qa-remediation-publication.js";
import { NATIVE_HELPER, PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
type Item = { op: "string_replace"; file: string; find: string; replace: string };

const BEFORE_A = "alpha old title beta\nsecond flaw gamma\n";
const AFTER_A = "alpha new title beta\nfixed gamma\n";
const BEFORE_B = "x marks the spot\n";
const AFTER_B = "y marks the spot\n";

/** 실제 소유 tmp 트리(macOS realpath 정규화) + before bytes 기록. */
async function workspace(): Promise<{ dir: string; fileA: string; fileB: string }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "qa-pub-")));
  const fileA = path.join(dir, "report.md");
  const fileB = path.join(dir, "notes.txt");
  await writeFile(fileA, BEFORE_A, "utf8");
  await writeFile(fileB, BEFORE_B, "utf8");
  return { dir, fileA, fileB };
}

interface FileSpec {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly replacements: readonly { find: string; replace: string }[];
}
const specA = (file: string): FileSpec => ({
  file, before: BEFORE_A, after: AFTER_A,
  replacements: [{ find: "old title", replace: "new title" }, { find: "second flaw", replace: "fixed" }],
});
const specB = (file: string): FileSpec => ({ file, before: BEFORE_B, after: AFTER_B, replacements: [{ find: "x", replace: "y" }] });

function preparation(specs: readonly FileSpec[]) {
  const verdicts = specs.map((spec, n) => {
    const items: Item[] = spec.replacements.map((r) => ({ op: "string_replace", file: spec.file, find: r.find, replace: r.replace }));
    return {
      eventId: id(0x10 + n), heartbeatRunId: id(0x20 + n),
      qa: { stepRunId: id(0x30 + n), stepId: `qa${n}`, issueId: id(0x40 + n), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
      items, remediationsHash: hashQaCorrectionPayload(items),
    };
  });
  const files = specs.map((s) => ({
    path: s.file, beforeSha256: sha(s.before), afterSha256: sha(s.after),
    beforeByteSize: Buffer.byteLength(s.before), afterByteSize: Buffer.byteLength(s.after),
  }));
  return {
    schemaVersion: "workflow.qa-remediation.prepare.v2" as const, preparationId: id(1), companyId: id(2), missionId: id(3),
    workflowRunId: id(4), dispatchAuthorityVersion: 7,
    producer: { stepRunId: id(5), stepId: "write", issueId: id(6), executionGeneration: 1, retryCount: 0, iterationIndex: 2 },
    verdicts, files, preparedAt: "2026-10-30T07:00:00.000Z",
  };
}

/** 호출자(B2 root) 소유 권한 선언 — 예약 바인딩 + 승인 경계(allowedDirs 형태). */
const authority = (prep: { preparationId: string; dispatchAuthorityVersion: number }, allowedDirs: string[]): QaRemediationPublicationAuthority => ({
  reservationEventId: prep.preparationId, dispatchAuthorityVersion: prep.dispatchAuthorityVersion,
  allowedFiles: new Set<string>(), allowedDirs,
});

/** Actual current-owner boundary: positive and deeper preflight paths use the native file-owner child. */
async function withNativeOwner<T>(prep: ReturnType<typeof preparation>, run: (owner: QaRemediationFileOwner) => Promise<T>): Promise<T> {
  const lockRoot = await realpath(await mkdtemp(path.join(tmpdir(), "qa-pub-lock-")));
  await chmod(lockRoot, 0o700);
  const owner = await QaRemediationFileOwner.begin({ lockRoot, targets: prep.files.map((file) => file.path).sort(),
    pythonCommand: PYTHON!, helperPath: NATIVE_HELPER });
  try {
    return await run(owner);
  } finally {
    expect(await owner.close()).toEqual({ code: 0, signal: null });
    await rm(lockRoot, { recursive: true, force: true });
  }
}

it("applies before-state files via atomic rename and verifies readback, mode, and temp cleanup", async () => {
  const ws = await workspace();
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  await chmod(ws.fileA, 0o640);
  expect(await publishQaRemediationPreparation(prep, authority(prep, [ws.dir]))).toMatchObject({ outcome: "held", reason: "owner_required" });
  const result = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(result.outcome).toBe("published");
  expect(result.files.map((f) => f.status)).toEqual(["applied", "applied"]);
  expect(await readFile(ws.fileA, "utf8")).toBe(AFTER_A);
  expect(await readFile(ws.fileB, "utf8")).toBe(AFTER_B);
  expect((await stat(ws.fileA)).mode & 0o7777).toBe(0o640);
  expect((await readdir(ws.dir)).sort()).toEqual(["notes.txt", "report.md"]);
});

it("verified-skips a file already at the after identity without rewriting it", async () => {
  const ws = await workspace();
  await writeFile(ws.fileA, AFTER_A, "utf8");
  const mtimeBefore = (await stat(ws.fileA)).mtimeMs;
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  const result = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(result.outcome).toBe("published");
  expect(result.files.map((f) => f.status)).toEqual(["already_applied", "applied"]);
  expect((await stat(ws.fileA)).mtimeMs).toBe(mtimeBefore);
  expect(await readFile(ws.fileA, "utf8")).toBe(AFTER_A);
});

it("recovers a partial publication: real io_error keeps applied files and re-invocation finishes the rest", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "qa-pub-partial-")));
  const subA = path.join(dir, "a");
  const subB = path.join(dir, "b");
  await mkdir(subA);
  await mkdir(subB);
  const fileA = path.join(subA, "report.md");
  const fileB = path.join(subB, "notes.txt");
  await writeFile(fileA, BEFORE_A, "utf8");
  await writeFile(fileB, BEFORE_B, "utf8");
  const prep = preparation([specA(fileA), specB(fileB)]);
  await chmod(subB, 0o500); // 실제 EACCES 로 fileB 기록 실패 유도
  const first = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [dir]), owner));
  expect(first.outcome).toBe("io_error");
  expect(first.files.map((f) => f.status)).toEqual(["applied", "io_error"]);
  expect(await readFile(fileA, "utf8")).toBe(AFTER_A);
  expect(await readFile(fileB, "utf8")).toBe(BEFORE_B);
  expect(await readdir(subB)).toEqual(["notes.txt"]); // temp 잔존 없음(cleanup finally)
  await chmod(subB, 0o755);
  const second = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [dir]), owner));
  expect(second.outcome).toBe("published");
  expect(second.files.map((f) => f.status)).toEqual(["already_applied", "applied"]);
  expect(await readFile(fileB, "utf8")).toBe(AFTER_B);
});

it("holds every file when any target is at neither before nor after identity", async () => {
  const ws = await workspace();
  await writeFile(ws.fileB, "tampered bytes", "utf8");
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  const result = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(result.outcome).toBe("held");
  expect(result).toMatchObject({ reason: "state_mismatch" });
  expect(result.files.map((f) => f.status)).toEqual(["held", "mismatch_held"]);
  expect(await readFile(ws.fileA, "utf8")).toBe(BEFORE_A);
});

it("holds when reconstructed bytes disagree with the recorded after identity", async () => {
  const ws = await workspace();
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  prep.files[0] = { ...prep.files[0]!, afterSha256: sha("some other after"), afterByteSize: 17 };
  const result = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(result.outcome).toBe("held");
  expect(result).toMatchObject({ reason: "reconstruction_mismatch" });
  expect(await readFile(ws.fileA, "utf8")).toBe(BEFORE_A);
  expect(await readFile(ws.fileB, "utf8")).toBe(BEFORE_B);
});

it("holds a malformed preparation without touching any file", async () => {
  const ws = await workspace();
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  const auth = authority(prep, [ws.dir]);
  const result = await publishQaRemediationPreparation({ ...prep, preparedAt: undefined }, auth);
  expect(result.outcome).toBe("held");
  expect(result).toMatchObject({ reason: "invalid_preparation" });
  expect(await readFile(ws.fileA, "utf8")).toBe(BEFORE_A);
});

it("refuses publication when caller authority does not bind the reservation or boundary", async () => {
  const ws = await workspace();
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  const wrongReservation = { ...authority(prep, [ws.dir]), reservationEventId: id(0x99) };
  expect(await publishQaRemediationPreparation(prep, wrongReservation)).toMatchObject({ reason: "authority_mismatch" });
  const otherDir = await realpath(await mkdtemp(path.join(tmpdir(), "qa-pub-other-")));
  expect(await publishQaRemediationPreparation(prep, authority(prep, [otherDir]))).toMatchObject({ reason: "authority_mismatch" });
  expect(await readFile(ws.fileA, "utf8")).toBe(BEFORE_A);
});

it("refuses a symlink alias instead of following or replacing it", async () => {
  const ws = await workspace();
  const target = path.join(ws.dir, "outside-target.md");
  await rm(ws.fileB, { force: true });
  await writeFile(target, BEFORE_B, "utf8");
  const link = path.join(ws.dir, "link.md");
  await symlink(target, link);
  const items: Item[] = [{ op: "string_replace", file: link, find: "x", replace: "y" }];
  const prep = {
    schemaVersion: "workflow.qa-remediation.prepare.v2" as const, preparationId: id(1), companyId: id(2), missionId: id(3),
    workflowRunId: id(4), dispatchAuthorityVersion: 7,
    producer: { stepRunId: id(5), stepId: "write", issueId: id(6), executionGeneration: 1, retryCount: 0, iterationIndex: 2 },
    verdicts: [{
      eventId: id(0x10), heartbeatRunId: id(0x20),
      qa: { stepRunId: id(0x30), stepId: "qa0", issueId: id(0x40), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
      items, remediationsHash: hashQaCorrectionPayload(items),
    }],
    files: [{ path: link, beforeSha256: sha(BEFORE_B), afterSha256: sha(AFTER_B), beforeByteSize: Buffer.byteLength(BEFORE_B), afterByteSize: Buffer.byteLength(AFTER_B) }],
    preparedAt: "2026-10-30T07:00:00.000Z",
  };
  // Native begin correctly rejects the symlink target itself; this preflight-only stub proves
  // the JS alias fence returns before invoking native publish. Native safety remains covered above.
  const preflightOnlyOwner = { targets: () => [link], publish: async () => { throw new Error("alias preflight must not reach native publish"); } } as unknown as QaRemediationFileOwner;
  const result = await publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), preflightOnlyOwner);
  expect(result.outcome).toBe("held");
  expect(result).toMatchObject({ reason: "alias_refused" });
  expect(await readFile(target, "utf8")).toBe(BEFORE_B);
  expect((await readdir(ws.dir)).sort()).toEqual(["link.md", "outside-target.md", "report.md"]);
});

it("never deletes pre-existing unknown temp residue — cleanup is limited to invocation-owned files", async () => {
  const ws = await workspace();
  const stale = path.join(ws.dir, ".report.md.qa-publish-unknown-old.tmp");
  await writeFile(stale, "old residue", "utf8");
  const prep = preparation([specA(ws.fileA), specB(ws.fileB)]);
  await chmod(ws.dir, 0o500); // temp 생성 실패(EACCES) — open(wx) 실패 시 이 호출은 소유권이 없다
  const denied = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(denied.outcome).toBe("io_error");
  await chmod(ws.dir, 0o755);
  const done = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [ws.dir]), owner));
  expect(done.outcome).toBe("published");
  expect(await readFile(stale, "utf8")).toBe("old residue"); // 미지의 잔존물은 그대로
});

it("requires the parent-directory fsync durability barrier for published — on apply and on after-hash retry", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "qa-pub-dsync-")));
  const fileA = path.join(dir, "report.md");
  await writeFile(fileA, BEFORE_A, "utf8");
  const prep = preparation([specA(fileA)]);
  await chmod(dir, 0o300); // w+x 만: 기록·rename·readback 는 가능, 디렉터리 fsync(open 'r')만 EACCES
  const first = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [dir]), owner));
  expect(first.outcome).toBe("io_error");
  expect(first.files[0]!.status).toBe("io_error");
  expect(await readFile(fileA, "utf8")).toBe(AFTER_A); // bytes 는 after — 그래도 내구성 미증명은 io_error
  const retry = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [dir]), owner)); // skip 도 장범 필요
  expect(retry.outcome).toBe("io_error");
  await chmod(dir, 0o755);
  const settled = await withNativeOwner(prep, (owner) => publishQaRemediationPreparation(prep, authority(prep, [dir]), owner));
  expect(settled.outcome).toBe("published");
  expect(settled.files[0]!.status).toBe("already_applied");
});
