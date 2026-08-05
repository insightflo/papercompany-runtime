// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissedRunIdList } from "./useInboxBadge";
import { heartbeatsApi } from "../api/heartbeats";

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

describe("dismissedRunIdList", () => {
  it("strips the run: prefix from dismissed keys", () => {
    expect(dismissedRunIdList(new Set(["run:abc"]))).toEqual(["abc"]);
  });

  it("ignores non-run keys (alerts, approvals, ...)", () => {
    expect(
      dismissedRunIdList(new Set(["run:abc", "alert:budget", "approval:xyz", "run:def"])),
    ).toEqual(["abc", "def"]);
  });

  it("sorts and dedupes regardless of insertion order", () => {
    const a = dismissedRunIdList(new Set(["run:b", "run:a", "run:a"]));
    const b = dismissedRunIdList(new Set(["run:a", "run:b"]));
    expect(a).toEqual(["a", "b"]);
    expect(b).toEqual(a);
  });

  it("caps at 200 ids", () => {
    const set = new Set<string>();
    for (let i = 0; i < 250; i += 1) set.add(`run:run-${String(i).padStart(3, "0")}`);
    expect(dismissedRunIdList(set)).toHaveLength(200);
  });

  it("returns an empty list for an empty set", () => {
    expect(dismissedRunIdList(new Set())).toEqual([]);
  });
});
describe("heartbeatsApi.attention dismissedRunIds query param", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes bare dismissed run ids as a comma-joined query param", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, {
      summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 },
      items: [],
      nextCursor: null,
    }));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    await heartbeatsApi.attention("company-1", {
      limit: 50,
      dismissedRunIds: ["run-a", "run-b"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/heartbeat-runs/attention?limit=50&dismissedRunIds=run-a%2Crun-b",
      expect.anything(),
    );
  });

  it("omits the dismissedRunIds param when the list is empty", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, {
      summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 },
      items: [],
      nextCursor: null,
    }));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    await heartbeatsApi.attention("company-1", { limit: 50, dismissedRunIds: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/heartbeat-runs/attention?limit=50",
      expect.anything(),
    );
  });
});
