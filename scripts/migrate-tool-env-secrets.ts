import { createRequire } from "node:module";
import { createDb, toolDefinitions } from "../packages/db/src/index.js";

// Resolve the server's existing dependency; scripts have no package manifest.
const { eq } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm") as typeof import("../server/node_modules/drizzle-orm/index.js");
import { secretService } from "../server/src/services/secrets.js";
import { planToolEnvSecrets, transformToolEnvSecrets } from "./lib/tool-env-secrets.js";

async function main() {
  const args = process.argv.slice(2);
  const filterIndex = args.indexOf("--tool-name");
  const toolName = filterIndex < 0 ? undefined : args[filterIndex + 1];
  if (filterIndex >= 0 && (!toolName || toolName.startsWith("--"))) {
    console.error("--tool-name requires a name");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  const apply = args.includes("--apply");
  const db = createDb(process.env.DATABASE_URL);
  let changed = 0, created = 0, rotated = 0, failed = 0;
  try {
    const rows = await db.select().from(toolDefinitions)
      .where(toolName === undefined ? undefined : eq(toolDefinitions.name, toolName));
    for (const row of rows) {
      const keys = planToolEnvSecrets(row).map(entry => entry.key);
      if (!keys.length) continue;
      try {
        let rowCreated = 0, rowRotated = 0;
        if (apply) {
          await db.transaction(async (tx) => {
            // Lock and re-read, avoiding overwriting concurrent config edits.
            const [tool] = await tx.select().from(toolDefinitions)
              .where(eq(toolDefinitions.id, row.id)).for("update");
            if (!tool) throw new Error("tool_missing");
            const secrets = secretService(tx as unknown as Parameters<typeof secretService>[0]);
            const result = await transformToolEnvSecrets(tool, true, async ({ name, value, key }) => {
              const existing = await secrets.getByName(tool.companyId, name);
              if (existing) {
                if (existing.provider !== "local_encrypted") throw new Error("secret_provider_mismatch");
                await secrets.rotate(existing.id, { value }, { userId: "migration", agentId: null });
                rowRotated += 1;
                return existing.id;
              }
              const secret = await secrets.create(tool.companyId, {
                name, provider: "local_encrypted", value,
                description: `Migrated tool env ${key}`,
              }, { userId: "migration", agentId: null });
              rowCreated += 1;
              return secret.id;
            });
            if (result.adapterConfig) {
              await tx.update(toolDefinitions).set({ adapterConfig: result.adapterConfig, updatedAt: new Date() })
                .where(eq(toolDefinitions.id, tool.id));
            }
          });
        }
        changed += 1; created += rowCreated; rotated += rowRotated;
        console.log(JSON.stringify({ tool: row.name, companyId: row.companyId, keys, count: keys.length }));
      } catch {
        failed += 1;
        // Never serialize DB/provider errors: they may contain bound plaintext.
        console.error(JSON.stringify({ tool: row.name, companyId: row.companyId, keys, failed: 1 }));
      }
    }
    console.log(`${apply ? "Updated" : "Dry run:"} ${changed} tools, created ${created} secrets, rotated ${rotated} secrets, failed ${failed}`);
    if (!apply) console.log("Re-run with --apply to persist changes");
    if (failed) process.exitCode = 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
void main().catch(() => {
  console.error("Tool env migration failed");
  process.exitCode = 1;
});
