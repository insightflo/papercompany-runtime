import { instanceSettings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/** Default OFF. Instance opt-in or explicit company allowlist; absent/malformed settings fail closed. */
export async function isQaRebindRecoveryEnabled(db: Pick<Db, "select">, companyId: string): Promise<boolean> {
  const [row] = await db.select({ experimental: instanceSettings.experimental }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const settings = row?.experimental;
  return settings?.enableQaRebindRecoveryV1 === true
    || (Array.isArray(settings?.enableQaRebindRecoveryCompanyIdsV1)
      && settings.enableQaRebindRecoveryCompanyIdsV1.includes(companyId));
}
