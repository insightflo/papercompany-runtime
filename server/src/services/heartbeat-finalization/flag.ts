import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

type SettingsReader = Pick<Db, "select">;

/**
 * This flag intentionally defaults to disabled for rows created before the
 * finalization-v1 shadow writers are enabled.
 */
export async function isHeartbeatFinalizationV1Enabled(db: SettingsReader): Promise<boolean> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.experimental?.enableHeartbeatFinalizationV1 === true;
}
