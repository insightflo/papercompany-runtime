import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionRollingDecisionRecord } from "@paperclipai/db";
import { sweepStaleDecisionEvidence } from "../services/missions/mission-decision-evidence-staleness.js";
import { buildMissionStateMarkdown } from "../services/missions/mission-runtime-manager.js";

function sha(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

const CLEAN_CONTENTS = "original work product contents";
const CHANGED_CONTENTS = "rewritten work product contents";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-stale-"));
  tempRoots.push(root);
  return root;
}

async function makeRootWithFile(relPath: string, contents: string): Promise<string> {
  const root = await makeRoot();
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents);
  return root;
}

function confirmedRecord(overrides: Partial<MissionRollingDecisionRecord> = {}): MissionRollingDecisionRecord {
  return {
    id: "D-1",
    summary: "Use the spike results",
    status: "confirmed",
    supersedes: null,
    handoffId: "handoff-1",
    updatedAt: "2026-09-05T00:00:00.000Z",
    evidenceRefs: [{ type: "work_product", id: "artifacts/wp.txt", sha256: sha(CLEAN_CONTENTS) }],
    ...overrides,
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe("sweepStaleDecisionEvidence", () => {
  it("demotes a confirmed decision when the referenced work_product file changed", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const record = confirmedRecord();

    const result = await sweepStaleDecisionEvidence([record], [root]);

    expect(result.demotions).toEqual([
      {
        id: "D-1",
        mismatches: [
          {
            id: "artifacts/wp.txt",
            type: "work_product",
            recordedSha256: sha(CLEAN_CONTENTS),
            current: "changed",
          },
        ],
      },
    ]);
    expect(result.verifiedCount).toBe(0);
    const demoted = result.decisions[0];
    expect(demoted.status).toBe("under_review");
    expect(demoted.demotedByEvidence?.previousStatus).toBe("confirmed");
    expect(demoted.demotedByEvidence?.mismatches).toEqual([
      { id: "artifacts/wp.txt", type: "work_product", recordedSha256: sha(CLEAN_CONTENTS), current: "changed" },
    ]);
    expect(Number.isNaN(Date.parse(demoted.demotedByEvidence?.at ?? "not-a-date"))).toBe(false);
    // 입력 배열/레코드는 변경하지 않고 새 배열을 돌려준다.
    expect(record.status).toBe("confirmed");
    expect(record.demotedByEvidence).toBeUndefined();
    expect(result.decisions).not.toBe([record]);
  });

  it("demotes on absolute-id missing under root; relative-id absent from all roots is unverifiable and skipped (fail-open)", async () => {
    const root = await makeRootWithFile("artifacts/vanished.txt", CLEAN_CONTENTS);
    await fs.rm(path.join(root, "artifacts/vanished.txt"));
    const absoluteId = path.join(root, "artifacts/also-vanished.txt");
    const record: MissionRollingDecisionRecord = {
      ...confirmedRecord(),
      evidenceRefs: [
        { type: "work_product", id: "artifacts/vanished.txt", sha256: sha(CLEAN_CONTENTS) },
        { type: "run_log", id: absoluteId, sha256: sha(CLEAN_CONTENTS) },
      ],
    };

    const result = await sweepStaleDecisionEvidence([record], [root]);

    // 상대 id 는 현재 루트에 없다는 것만으로는 소실 입증 불가(다른 루트에 있을 수 있음) — 스킵.
    // 절대 id 는 정확한 경로가 루트 내에서 사라진 것이므로 소실 판정.
    expect(result.decisions[0].status).toBe("under_review");
    expect(result.decisions[0].demotedByEvidence?.mismatches).toEqual([
      { id: absoluteId, type: "run_log", recordedSha256: sha(CLEAN_CONTENTS), current: "missing" },
    ]);
  });

  it("leaves the decision confirmed when the recorded hash still matches", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CLEAN_CONTENTS);

    const result = await sweepStaleDecisionEvidence([confirmedRecord()], [root]);

    expect(result.decisions[0].status).toBe("confirmed");
    expect(result.decisions[0].demotedByEvidence).toBeUndefined();
    expect(result.demotions).toEqual([]);
    expect(result.verifiedCount).toBe(1);
  });

  it("demotes a board-sourced confirmed record too, keeping source and lastConflictingProposal untouched", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const record = confirmedRecord({
      source: "board",
      lastConflictingProposal: { from: "agent", summary: "agent disagrees", at: "2026-09-05T01:00:00.000Z" },
    });

    const result = await sweepStaleDecisionEvidence([record], [root]);

    expect(result.decisions[0].status).toBe("under_review");
    expect(result.decisions[0].demotedByEvidence).toBeDefined();
    expect(result.decisions[0].source).toBe("board");
    expect(result.decisions[0].lastConflictingProposal).toEqual({
      from: "agent",
      summary: "agent disagrees",
      at: "2026-09-05T01:00:00.000Z",
    });
  });

  it("skips refs that are neither work_product/run_log nor carry a 64-hex sha256", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const record: MissionRollingDecisionRecord = {
      ...confirmedRecord(),
      evidenceRefs: [
        { type: "issue", id: "artifacts/wp.txt", sha256: sha(CLEAN_CONTENTS) },
        { type: "work_product", id: "artifacts/wp.txt" },
        { type: "run_log", id: "run-1234" },
      ],
    };

    const result = await sweepStaleDecisionEvidence([record], [root]);

    expect(result.decisions[0].status).toBe("confirmed");
    expect(result.decisions[0].demotedByEvidence).toBeUndefined();
    expect(result.demotions).toEqual([]);
    expect(result.verifiedCount).toBe(0);
  });

  it("skips absolute paths outside the verification roots and relative ids escaping every root", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const outsideRoot = await makeRootWithFile("outside.txt", CHANGED_CONTENTS);
    const record: MissionRollingDecisionRecord = {
      ...confirmedRecord(),
      evidenceRefs: [
        { type: "work_product", id: path.join(outsideRoot, "outside.txt"), sha256: sha(CLEAN_CONTENTS) },
        { type: "run_log", id: "../outside.txt", sha256: sha(CLEAN_CONTENTS) },
      ],
    };

    const result = await sweepStaleDecisionEvidence([record], [root]);

    expect(result.decisions[0].status).toBe("confirmed");
    expect(result.demotions).toEqual([]);
    expect(result.verifiedCount).toBe(0);
  });

  it("skips records already carrying demotedByEvidence even when evidence changed again", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const record = confirmedRecord({
      status: "under_review",
      demotedByEvidence: {
        at: "2026-09-05T02:00:00.000Z",
        previousStatus: "confirmed",
        mismatches: [{ id: "artifacts/wp.txt", type: "work_product", recordedSha256: sha("older"), current: "changed" }],
      },
    });

    const result = await sweepStaleDecisionEvidence([record], [root]);

    expect(result.decisions[0]).toEqual(record);
    expect(result.demotions).toEqual([]);
    expect(result.verifiedCount).toBe(0);
  });

  it("is a no-op when roots are undefined or empty", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);
    const record = confirmedRecord();

    for (const roots of [undefined, []]) {
      const result = await sweepStaleDecisionEvidence([record], roots);
      expect(result.decisions).toEqual([record]);
      expect(result.demotions).toEqual([]);
      expect(result.verifiedCount).toBe(0);
    }
    // roots 가 있어도 결정 로그가 비면 아무 일도 없다.
    const empty = await sweepStaleDecisionEvidence([], [root]);
    expect(empty.decisions).toEqual([]);
    expect(empty.demotions).toEqual([]);
  });

  it("never demotes non-confirmed statuses even with proven mismatches", async () => {
    const root = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);

    const result = await sweepStaleDecisionEvidence(
      [confirmedRecord({ id: "D-U", status: "under_review" }), confirmedRecord({ id: "D-R", status: "retired" })],
      [root],
    );

    expect(result.decisions.map((d) => d.status)).toEqual(["under_review", "retired"]);
    expect(result.decisions.every((d) => d.demotedByEvidence === undefined)).toBe(true);
    expect(result.demotions).toEqual([]);
  });

  it("resolves a relative id against the first root that contains the file (first existing wins)", async () => {
    const rootA = await makeRootWithFile("artifacts/wp.txt", CLEAN_CONTENTS);
    const rootB = await makeRootWithFile("artifacts/wp.txt", CHANGED_CONTENTS);

    const cleanFirst = await sweepStaleDecisionEvidence([confirmedRecord()], [rootA, rootB]);
    expect(cleanFirst.decisions[0].status).toBe("confirmed");
    expect(cleanFirst.verifiedCount).toBe(1);

    const missingInA = await makeRoot();
    const fallback = await sweepStaleDecisionEvidence([confirmedRecord()], [missingInA, rootB]);
    expect(fallback.decisions[0].status).toBe("under_review");
    expect(fallback.decisions[0].demotedByEvidence?.mismatches[0].current).toBe("changed");
  });

  it("collects every stale ref mismatch for a decision and skips unreadable paths without throwing", async () => {
    const root = await makeRootWithFile("a.txt", CHANGED_CONTENTS);
    await fs.writeFile(path.join(root, "b.txt"), CHANGED_CONTENTS);
    await fs.mkdir(path.join(root, "is-a-directory"));
    const record: MissionRollingDecisionRecord = {
      ...confirmedRecord(),
      evidenceRefs: [
        { type: "work_product", id: "a.txt", sha256: sha(CLEAN_CONTENTS) },
        { type: "run_log", id: "b.txt", sha256: sha(CLEAN_CONTENTS) },
        { type: "work_product", id: "is-a-directory", sha256: sha(CLEAN_CONTENTS) },
      ],
    };

    const result = await sweepStaleDecisionEvidence([record], [root]);

    // 디렉터리(읽을 수 없는 경로)는 불일치가 아니라 조용히 건너뛴다.
    expect(result.decisions[0].demotedByEvidence?.mismatches).toEqual([
      { id: "a.txt", type: "work_product", recordedSha256: sha(CLEAN_CONTENTS), current: "changed" },
      { id: "b.txt", type: "run_log", recordedSha256: sha(CLEAN_CONTENTS), current: "changed" },
    ]);
  });
});

describe("buildMissionStateMarkdown (evidence stale marker)", () => {
  it("appends the evidence stale marker to demoted decision lines only", () => {
    const markdown = buildMissionStateMarkdown({
      missionId: "mission-1",
      state: {
        decisions: [
          {
            id: "D-1",
            summary: "Use the spike results",
            status: "under_review",
            demotedByEvidence: {
              at: "2026-09-05T02:00:00.000Z",
              previousStatus: "confirmed",
              mismatches: [{ id: "artifacts/wp.txt", type: "work_product", recordedSha256: sha(CLEAN_CONTENTS), current: "changed" }],
            },
          },
          { id: "D-2", summary: "Still confirmed", status: "confirmed" },
        ],
      },
    });

    expect(markdown).toContain("- [under_review] D-1: Use the spike results · evidence stale");
    expect(markdown).toContain("- [confirmed] D-2: Still confirmed");
    expect(markdown).not.toContain("D-2: Still confirmed · evidence stale");
  });
});
