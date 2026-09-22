import { describe, expect, it } from "vitest";
import { instanceSettings, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";

type Row = Record<string, unknown>;

/**
 * 최소 인메모리 DB 픽스처 — instanceSettingsService 가 사용하는 select/insert/update
 * 체인만 흉내낸다. 객체 컬럼은 저장 시 JSON 직렬화를 거치게 해서(undefined 키 삭제,
 * JSONB 저장 동작) 운영 저장 의미를 맞춘다. 조건/정렬은 단일 행 픽스처로 제어한다.
 */
function makeInstanceSettingsDb() {
  const tableRows = new Map<unknown, Row[]>([[instanceSettings, []]]);
  let nextId = 0;
  const toJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const rowsQuery = (result: Row[]) => {
    const query: Record<string, unknown> = {
      then: (onFulfilled: (rows: Row[]) => unknown, onRejected?: unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected as never),
    };
    for (const link of ["where", "orderBy", "limit"]) query[link] = () => query;
    return query as never;
  };
  const serializeObjects = (values: Row): Row => {
    const serialized: Row = { ...values };
    for (const key of Object.keys(serialized)) {
      const value = serialized[key];
      if (value !== null && typeof value === "object") serialized[key] = toJson(value);
    }
    return serialized;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => rowsQuery([...(tableRows.get(table) ?? [])]),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const row = { id: `row-${++nextId}`, ...serializeObjects(values) };
            tableRows.get(table)!.push(row);
            return rowsQuery([row]);
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: () => {
            const merged = (tableRows.get(table) ?? []).map((row) => ({
              ...row,
              ...serializeObjects(values),
            }));
            tableRows.set(table, merged);
            return rowsQuery(merged);
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, tableRows };
}

describe("instance general settings — judgment overrides", () => {
  it("updateGeneral with judgmentBaseUrl persists it and getGeneral returns it", async () => {
    const { db } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);

    await svc.updateGeneral({ judgmentBaseUrl: "https://api.example.com" });

    const general = await svc.getGeneral();
    expect(general.censorUsernameInLogs).toBe(false);
    expect(general.judgmentBaseUrl).toBe("https://api.example.com");
  });

  it("judgmentModelId null clears only the model override", async () => {
    const { db } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);

    await svc.updateGeneral({ censorUsernameInLogs: true });
    await svc.updateGeneral({ judgmentBaseUrl: "http://127.0.0.1:19871", judgmentModelId: "alt-model-1" });
    await svc.updateGeneral({ judgmentModelId: null });

    const general = await svc.getGeneral();
    expect(general.censorUsernameInLogs).toBe(true);
    expect(general.judgmentBaseUrl).toBe("http://127.0.0.1:19871");
    expect(general.judgmentModelId).toBeUndefined();
  });

  it("stored garbage for one judgment field does not reset censorUsernameInLogs", async () => {
    const { db, tableRows } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ censorUsernameInLogs: true, judgmentModelId: "alt-model-1" });

    // 스키마 밖 경로로 한 필드만 손상된 값이 들어온 상황 시뮬레이션.
    tableRows.get(instanceSettings)![0]!.general = {
      censorUsernameInLogs: true,
      judgmentBaseUrl: "not a url",
      judgmentModelId: "alt-model-1",
    };

    const general = await svc.getGeneral();
    expect(general.censorUsernameInLogs).toBe(true);
    expect(general.judgmentBaseUrl).toBeUndefined();
    expect(general.judgmentModelId).toBe("alt-model-1");
  });
});
