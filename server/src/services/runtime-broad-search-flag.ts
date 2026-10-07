import { instanceSettings, type Db } from "@paperclipai/db";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { eq } from "drizzle-orm";

/** Default DENY. Identities are the scoped issue's mission and the caller's running agent. */
export async function isBroadSearchAllowed(
  db: Pick<Db, "select">,
  scope: { companyId: string; missionId: string | null; agentId: string | null },
): Promise<boolean> {
  const [row] = await db.select({ experimental: instanceSettings.experimental }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const parsed = instanceExperimentalSettingsSchema.safeParse(row?.experimental);
  if (!parsed.success) return false;
  const settings = parsed.data;
  return settings.broadSearchAllowedCompanyIdsV1.includes(scope.companyId)
    || (scope.missionId !== null && settings.broadSearchAllowedMissionIdsV1.includes(scope.missionId))
    || (scope.agentId !== null && settings.broadSearchAllowedAgentIdsV1.includes(scope.agentId));
}
