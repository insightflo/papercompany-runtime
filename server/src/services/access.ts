import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  instanceUserRoles,
  permissionGroupMembers,
  permissionGroups,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export function accessService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  // Checks grant row existence only (no membership check). hasPermission/canUser compose this.
  async function hasPrincipalGrant(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    return hasPrincipalGrant(companyId, principalType, principalId, permissionKey);
  }

  // Returns true if any active group the user belongs to (same company) holds an active grant.
  // groupId is uuid while principalId is text, so cast uuid columns to text in the join.
  // cross-company guard: grant/member/group all share companyId; suspended groups/members excluded.
  async function hasInheritedGroupGrant(
    companyId: string,
    userId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const row = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .innerJoin(
        permissionGroupMembers,
        and(
          eq(permissionGroupMembers.companyId, principalPermissionGrants.companyId),
          sql`${permissionGroupMembers.groupId}::text = ${principalPermissionGrants.principalId}`,
          eq(permissionGroupMembers.userId, userId),
          eq(permissionGroupMembers.status, "active"),
        ),
      )
      .innerJoin(
        permissionGroups,
        and(
          sql`${permissionGroups.id}::text = ${principalPermissionGrants.principalId}`,
          eq(permissionGroups.companyId, principalPermissionGrants.companyId),
          eq(permissionGroups.status, "active"),
        ),
      )
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "group"),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    // rule 3: user must hold an active company membership; this also gates group inheritance.
    const membership = await getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") return false;
    // direct user grant OR inherited active-group grant
    return (
      (await hasPrincipalGrant(companyId, "user", userId, permissionKey)) ||
      hasInheritedGroupGrant(companyId, userId, permissionKey)
    );
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function listActiveUserMemberships(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(userId: string, companyIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toDelete = existing.filter((row) => !target.has(row.companyId)).map((row) => row.id);
      if (toDelete.length > 0) {
        await tx.delete(companyMemberships).where(inArray(companyMemberships.id, toDelete));
      }

      for (const companyId of target) {
        if (existingByCompany.has(companyId)) continue;
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({ status, membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
    }
    return sourceMemberships;
  }

  async function listPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(companyId, principalType, principalId, "member", "active");

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType,
      principalId,
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // --- Permission groups (Phase 2). Every query is scoped by companyId so a
  // cross-company groupId/memberId is treated as not-found rather than leaking. ---

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

  async function createGroup(
    companyId: string,
    input: { name: string; description?: string | null; status?: string },
  ) {
    const [row] = await db
      .insert(permissionGroups)
      .values({
        companyId,
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? "active",
      })
      .returning();
    return row;
  }

  async function updateGroup(
    companyId: string,
    groupId: string,
    patch: { name?: string; description?: string | null; status?: string },
  ) {
    const changes: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.status !== undefined) changes.status = patch.status;
    const [row] = await db
      .update(permissionGroups)
      .set(changes)
      .where(and(eq(permissionGroups.id, groupId), eq(permissionGroups.companyId, companyId)))
      .returning();
    return row ?? null;
  }

  // Delete order: group grants -> members -> group row. A cross-company groupId is a no-op via scoped WHERE.
  async function deleteGroup(companyId: string, groupId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "group"),
            eq(principalPermissionGrants.principalId, groupId),
          ),
        );
      await tx
        .delete(permissionGroupMembers)
        .where(
          and(
            eq(permissionGroupMembers.companyId, companyId),
            eq(permissionGroupMembers.groupId, groupId),
          ),
        );
      const removed = await tx
        .delete(permissionGroups)
        .where(
          and(eq(permissionGroups.id, groupId), eq(permissionGroups.companyId, companyId)),
        )
        .returning({ id: permissionGroups.id });
      return removed.length > 0;
    });
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

  // addUserIds are inserted active (onConflict do nothing guards the unique index);
  // removeUserIds are deleted. All scoped by companyId + groupId.
  async function updateGroupMembers(
    companyId: string,
    groupId: string,
    input: { addUserIds?: string[]; removeUserIds?: string[] },
  ) {
    const add = input.addUserIds ?? [];
    const remove = input.removeUserIds ?? [];
    await db.transaction(async (tx) => {
      if (remove.length > 0) {
        await tx
          .delete(permissionGroupMembers)
          .where(
            and(
              eq(permissionGroupMembers.companyId, companyId),
              eq(permissionGroupMembers.groupId, groupId),
              inArray(permissionGroupMembers.userId, remove),
            ),
          );
      }
      for (const userId of add) {
        await tx
          .insert(permissionGroupMembers)
          .values({ companyId, groupId, userId, status: "active" })
          .onConflictDoNothing();
      }
    });
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

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    listGroups,
    getGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    listGroupMembers,
    updateGroupMembers,
    listUserGroupMemberships,
  };
}
