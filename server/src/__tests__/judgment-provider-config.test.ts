import { describe, expect, it } from "vitest";
import { instanceSettings, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  resolveJudgmentModel,
  resolveJudgmentProviderConfig,
} from "../services/judgment/provider-config.js";

type Row = Record<string, unknown>;

/** 최소 인메모리 DB 픽스처 — instanceSettingsService 가 사용하는 체인만 흉내낸다. */
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

describe("resolveJudgmentProviderConfig", () => {
  it("returns saved judgment overrides", async () => {
    const { db } = makeInstanceSettingsDb();
    await instanceSettingsService(db).updateGeneral({
      judgmentBaseUrl: "http://127.0.0.1:9",
      judgmentModelId: "alt-model-1",
    });

    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9",
      modelId: "alt-model-1",
    });
  });

  it("omits cleared (null) overrides instead of returning null", async () => {
    const { db } = makeInstanceSettingsDb();
    const svc = instanceSettingsService(db);
    await svc.updateGeneral({ judgmentBaseUrl: "http://127.0.0.1:9", judgmentModelId: "alt-model-1" });
    await svc.updateGeneral({ judgmentModelId: null });

    await expect(resolveJudgmentProviderConfig(db)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:9",
    });
  });
});

describe("resolveJudgmentModel", () => {
  it("override wins; unset and null fall back to the definition model id", () => {
    expect(resolveJudgmentModel({ modelId: "alt-model-1" }, "jev-1.13.0")).toBe("alt-model-1");
    expect(resolveJudgmentModel({}, "jev-1.13.0")).toBe("jev-1.13.0");
    expect(resolveJudgmentModel({ modelId: null as unknown as string }, "jev-1.13.0")).toBe("jev-1.13.0");
  });
});
