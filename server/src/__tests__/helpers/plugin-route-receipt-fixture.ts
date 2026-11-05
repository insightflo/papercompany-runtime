import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { vi } from "vitest";

export const PLUGIN_ROUTE_RECEIPT_COMPANY_ID = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b001";

type LookupFixture = { rows?: unknown[]; rowQueue?: unknown[][]; onLookupSelect?: () => void };

/** Real PostgreSQL for receipt operations, with the route tests' unrelated lookup rows kept local. */
export async function startPluginRouteReceiptFixture() {
  const tempDb = await startEmbeddedPostgresTestDatabase("plugin-route-receipts-");
  const db = createDb(tempDb.connectionString);
  await db.insert(companies).values({ id: PLUGIN_ROUTE_RECEIPT_COMPANY_ID, name: "Plugin Route Receipt Test" });

  return {
    db,
    routeDb(lookup: LookupFixture = {}) {
      return createRouteDbWithReceiptPersistence(db, lookup);
    },
    async cleanup() {
      await db.$client.end({ timeout: 5 });
      await tempDb.cleanup();
    },
  };
}

function createRouteDbWithReceiptPersistence(db: Db, lookup: LookupFixture): Db {
  const rowQueue = [...(lookup.rowQueue ?? [])];
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rowQueue.length > 0 ? rowQueue.shift() : (lookup.rows ?? [])),
  };

  return new Proxy(db, {
    get(target, property) {
      if (property === "select") {
        const select = Reflect.get(target, property, target).bind(target) as (...args: unknown[]) => object;
        return (...args: unknown[]) => {
          const builder = select(...args);
          const from = Reflect.get(builder, "from", builder) as (table: unknown) => unknown;
          return new Proxy(builder, {
            get(builderTarget, queryProperty) {
              if (queryProperty === "from") {
                return (table: unknown) => {
                  if (table === pluginToolExecutionReceipts) return from.call(builderTarget, table);
                  lookup.onLookupSelect?.();
                  return query.from(table);
                };
              }
              return Reflect.get(builderTarget, queryProperty, builderTarget);
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Gives legacy executeTool spies the same actual-result observation contract as the native dispatcher. */
export function observeExecuteToolSpy<T extends { executeTool: (...args: any[]) => Promise<unknown> }>(dispatcher: T) {
  let nextId = 1;
  return Object.assign(dispatcher, {
    executeToolObserved: vi.fn((name: string, parameters: unknown, context: unknown, identity: unknown) => {
      const id = nextId++;
      let state: "pending" | "settled" = "pending";
      let acknowledged = false;
      const actual = Promise.resolve().then(() => dispatcher.executeTool(name, parameters, context)).then(
        (result) => {
          state = "settled";
          return { kind: "result" as const, result, response: { jsonrpc: "2.0" as const, id, result } };
        },
        (error: unknown) => {
          state = "settled";
          const rpcError = error instanceof JsonRpcCallError
            ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
            : { code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: error instanceof Error ? error.message : String(error) };
          return { kind: "error" as const, error: rpcError, response: { jsonrpc: "2.0" as const, id, error: rpcError } };
        },
      );
      const initial = actual.then((outcome) => {
        if (outcome.kind === "error") throw new JsonRpcCallError(outcome.error);
        return outcome.result;
      });
      const separator = name.lastIndexOf(":");
      const pluginId = separator < 0 ? name : name.slice(0, separator);
      const toolName = separator < 0 ? name : name.slice(separator + 1);
      return {
        pluginId,
        toolName,
        identity,
        kind: "sent_or_unknown" as const,
        observation: {
          kind: "sent_or_unknown" as const,
          initial,
          actual,
          state: () => state,
          acknowledge: () => {
            if (state !== "settled" || acknowledged) return false;
            acknowledged = true;
            return true;
          },
        },
      };
    }),
  });
}
