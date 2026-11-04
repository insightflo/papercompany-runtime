import { and, eq } from "drizzle-orm";
import { permissionGroups, permissionGroupMembers, type Db } from "@paperclipai/db";

export function createAccessGroupReaders(db: Db) {
  async function listGroups(companyId: string) {
    return db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.companyId, companyId))
      .orderBy(permissionGroups.name);
  }

  async function getGroup(companyId: string, groupId: string) {
    return db
      .select()
      .from(permissionGroups)
      .where(and(eq(permissionGroups.id, groupId), eq(permissionGroups.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function listGroupMembers(companyId: string, groupId: string) {
    return db
      .select()
      .from(permissionGroupMembers)
      .where(
        and(
          eq(permissionGroupMembers.companyId, companyId),
          eq(permissionGroupMembers.groupId, groupId),
        ),
      )
      .orderBy(permissionGroupMembers.createdAt);
  }

  // Used to enrich GET /members with each user's active group memberships.
  async function listUserGroupMemberships(companyId: string, userId: string) {
    return db
      .select({ groupId: permissionGroupMembers.groupId, status: permissionGroupMembers.status })
      .from(permissionGroupMembers)
      .where(
        and(
          eq(permissionGroupMembers.companyId, companyId),
          eq(permissionGroupMembers.userId, userId),
          eq(permissionGroupMembers.status, "active"),
        ),
      );
  }

  return { listGroups, getGroup, listGroupMembers, listUserGroupMemberships };
}
