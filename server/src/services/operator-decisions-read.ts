import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { operatorDecisions } from "@paperclipai/db";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import type { OperatorDecisionListQuery } from "@paperclipai/shared/validators/operator-decision";
import { badRequest, notFound } from "../errors.js";
import { loadOperatorDecisionProjection } from "./operator-decision-view.js";

const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
type ViewName = "pending" | "attention" | "history";
type Cursor = { view: ViewName; sort: [number, string, string] | [string, string] };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function decodeCursor(raw: string | undefined, view: ViewName): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== raw) throw new Error("Non-canonical cursor");
    const value = JSON.parse(decoded) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "sort,view" || value.view !== view || !Array.isArray(value.sort)) {
      throw new Error("Cursor view mismatch");
    }
    if (view === "pending") {
      const [rank, createdAt, id] = value.sort;
      if (value.sort.length !== 3 || !Number.isInteger(rank) || Number(rank) < 0 || Number(rank) > 3 ||
        !parseIso(createdAt) || typeof id !== "string") throw new Error("Invalid pending cursor");
    } else {
      const [at, id] = value.sort;
      if (value.sort.length !== 2 || !parseIso(at) || typeof id !== "string") throw new Error("Invalid cursor");
    }
    return value as unknown as Cursor;
  } catch {
    throw badRequest("Validation error", [{ code: "custom", path: ["cursor"], message: "Invalid cursor" }]);
  }
}

function pendingTuple(item: OperatorDecisionView): [number, string, string] {
  return [priorityRank[item.priority] ?? 4, item.createdAt, item.id];
}
function historyTuple(item: OperatorDecisionView): [string, string] {
  return [item.resolvedAt ?? item.cancelledAt ?? item.updatedAt, item.id];
}
function compareAscending(left: readonly (number | string)[], right: readonly (number | string)[]) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}
function compareDescending(left: readonly (number | string)[], right: readonly (number | string)[]) {
  return -compareAscending(left, right);
}

export function operatorDecisionReadService(db: Db) {
  async function getById(id: string): Promise<OperatorDecisionView | null> {
    const row = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? (await loadOperatorDecisionProjection(db, row)).view : null;
  }

  async function getRequired(id: string): Promise<OperatorDecisionView> {
    const decision = await getById(id);
    if (!decision) throw notFound("Operator decision not found");
    return decision;
  }

  async function list(companyId: string, query: OperatorDecisionListQuery) {
    const cursor = decodeCursor(query.cursor, query.view);
    const statusFilter = query.view === "pending" ? ["pending"] : ["resolved", "cancelled"];
    const rows = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, companyId),
      inArray(operatorDecisions.status, statusFilter),
    ));
    const projections = await Promise.all(rows.map((row) => loadOperatorDecisionProjection(db, row)));
    let items = projections.map((item) => item.view);
    let cursorFor: (item: OperatorDecisionView) => Cursor;

    if (query.view === "pending") {
      items.sort((left, right) => compareAscending(pendingTuple(left), pendingTuple(right)));
      if (cursor) items = items.filter((item) => compareAscending(pendingTuple(item), cursor.sort) > 0);
      cursorFor = (item) => ({ view: "pending", sort: pendingTuple(item) });
    } else if (query.view === "attention") {
      const attentionIds = new Set(projections.filter((item) => item.attention).map((item) => item.view.id));
      const updatedAtById = new Map(projections.map((item) => [
        item.view.id,
        item.continuationUpdatedAt?.toISOString() ?? item.view.updatedAt,
      ]));
      items = items.filter((item) => item.status === "resolved" && attentionIds.has(item.id));
      const tuple = (item: OperatorDecisionView): [string, string] => [updatedAtById.get(item.id)!, item.id];
      items.sort((left, right) => compareDescending(tuple(left), tuple(right)));
      if (cursor) items = items.filter((item) => compareDescending(tuple(item), cursor.sort) > 0);
      cursorFor = (item) => ({ view: "attention", sort: tuple(item) });
    } else {
      items.sort((left, right) => compareDescending(historyTuple(left), historyTuple(right)));
      if (cursor) items = items.filter((item) => compareDescending(historyTuple(item), cursor.sort) > 0);
      cursorFor = (item) => ({ view: "history", sort: historyTuple(item) });
    }

    const hasMore = items.length > query.limit;
    const data = items.slice(0, query.limit);
    return {
      data,
      page: { nextCursor: hasMore && data.length > 0 ? encodeCursor(cursorFor(data[data.length - 1]!)) : null },
    };
  }

  return { getById, getRequired, list };
}
