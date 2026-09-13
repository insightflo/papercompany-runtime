import { and, eq } from "drizzle-orm";
import { authUsers, boardApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { qualityHumanActorSchema, type QualityHumanActor } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import type { QualityTx } from "./targets.js";

export async function assertQualityUser(tx: QualityTx, companyId: string, userId: string): Promise<void> {
  const [user] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)).for("share");
  if (!user || userId === "local-board") throw forbidden("quality_human_unavailable");
  const admins = await tx.select().from(instanceUserRoles).where(and(
    eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"),
  )).for("share");
  if (admins.length) return;
  const members = await tx.select().from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
  )).for("share");
  if (!members.length) throw forbidden("quality_human_unavailable");
}

/** Only trusted HTTP auth supplies this actor; never read it from a request body. */
export async function assertQualityHuman(tx: QualityTx, companyId: string, input: QualityHumanActor): Promise<void> {
  const actor = qualityHumanActorSchema.parse(input);
  if (actor.source === "local_implicit") {
    if (actor.userId !== "local-board" || actor.keyId !== null) throw forbidden("quality_invalid_local_actor");
    return;
  }
  await assertQualityUser(tx, companyId, actor.userId);
  if (actor.source === "session") {
    if (actor.keyId !== null) throw forbidden("quality_invalid_session_actor");
    return;
  }
  if (!actor.keyId) throw forbidden("quality_board_key_unavailable");
  const [key] = await tx.select().from(boardApiKeys).where(and(
    eq(boardApiKeys.id, actor.keyId), eq(boardApiKeys.userId, actor.userId),
  )).for("share");
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) {
    throw forbidden("quality_board_key_unavailable");
  }
}
