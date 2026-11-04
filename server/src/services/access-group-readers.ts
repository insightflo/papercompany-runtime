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

  return { listGroups, getGroup, listGroupMembers };
}
