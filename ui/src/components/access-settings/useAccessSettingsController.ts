import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PermissionKey } from "@paperclipai/shared";
import { useToast } from "../../context/ToastContext";
import {
  accessApi,
  type AccessGrantInput,
  type CompanyAccessMember,
} from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage, toggleGrant } from "./utils";

export function useAccessSettingsController(selectedCompanyId: string | null) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [editingGroupName, setEditingGroupName] = useState("");
  const [editingGroupDescription, setEditingGroupDescription] = useState("");

  const accessMembersQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.access.members(selectedCompanyId)
      : ["access", "members", "__no-company__"],
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const permissionGroupsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.access.permissionGroups(selectedCompanyId)
      : ["access", "permission-groups", "__no-company__"],
    queryFn: () => accessApi.listPermissionGroups(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const permissionGroups = useMemo(
    () => permissionGroupsQuery.data ?? [],
    [permissionGroupsQuery.data]
  );
  const accessMembers = useMemo(
    () => accessMembersQuery.data ?? [],
    [accessMembersQuery.data]
  );
  const userMembers = useMemo(
    () => accessMembers.filter((member) => member.principalType === "user"),
    [accessMembers]
  );
  const groupById = useMemo(
    () => new Map(permissionGroups.map((group) => [group.id, group])),
    [permissionGroups]
  );
  const selectedGroup = selectedGroupId
    ? permissionGroups.find((group) => group.id === selectedGroupId) ?? null
    : null;

  const selectedGroupDetailQuery = useQuery({
    queryKey:
      selectedCompanyId && selectedGroupId
        ? queryKeys.access.permissionGroup(selectedCompanyId, selectedGroupId)
        : ["access", "permission-groups", "__no-company__", "__no-group__"],
    queryFn: () => accessApi.getPermissionGroup(selectedCompanyId!, selectedGroupId!),
    enabled: !!selectedCompanyId && !!selectedGroupId,
  });
  const selectedGroupDetail = selectedGroupDetailQuery.data ?? null;

  useEffect(() => {
    if (!selectedCompanyId) {
      setSelectedGroupId(null);
      return;
    }
    if (!permissionGroupsQuery.data) return;
    setSelectedGroupId((current) => {
      if (current && permissionGroups.some((group) => group.id === current)) return current;
      return permissionGroups[0]?.id ?? null;
    });
  }, [selectedCompanyId, permissionGroups, permissionGroupsQuery.data]);

  useEffect(() => {
    setEditingGroupName(selectedGroup?.name ?? "");
    setEditingGroupDescription(selectedGroup?.description ?? "");
  }, [selectedGroup?.id, selectedGroup?.name, selectedGroup?.description]);

  useEffect(() => {
    setNewGroupName("");
    setNewGroupDescription("");
  }, [selectedCompanyId]);

  function invalidateAccessQueries(groupId?: string | null) {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.access.members(selectedCompanyId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.access.permissionGroups(selectedCompanyId),
    });
    if (groupId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.access.permissionGroup(selectedCompanyId, groupId),
      });
    }
  }

  const updateMemberPermissionsMutation = useMutation({
    mutationFn: ({ memberId, grants }: { memberId: string; grants: AccessGrantInput[] }) =>
      accessApi.updateMemberPermissions(selectedCompanyId!, memberId, grants),
    onSuccess: () => invalidateAccessQueries(),
    onError: (err) =>
      pushToast({
        title: "Permission update failed",
        body: getErrorMessage(err, "Unable to update user permissions."),
        tone: "error",
      }),
  });
  const createGroupMutation = useMutation({
    mutationFn: () =>
      accessApi.createPermissionGroup(selectedCompanyId!, {
        name: newGroupName.trim(),
        description: newGroupDescription.trim() || null,
        status: "active",
      }),
    onSuccess: (group) => {
      setNewGroupName("");
      setNewGroupDescription("");
      setSelectedGroupId(group.id);
      invalidateAccessQueries(group.id);
      pushToast({ title: "Group created", body: group.name, tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Group creation failed",
        body: getErrorMessage(err, "Unable to create group."),
        tone: "error",
      }),
  });
  const updateGroupMutation = useMutation({
    mutationFn: ({
      groupId,
      ...input
    }: {
      groupId: string;
      name?: string;
      description?: string | null;
      status?: "active" | "suspended";
    }) => accessApi.updatePermissionGroup(selectedCompanyId!, groupId, input),
    onSuccess: (group) => {
      invalidateAccessQueries(group.id);
      pushToast({ title: "Group updated", body: group.name, tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Group update failed",
        body: getErrorMessage(err, "Unable to update group."),
        tone: "error",
      }),
  });
  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) =>
      accessApi.deletePermissionGroup(selectedCompanyId!, groupId).then(() => groupId),
    onSuccess: (groupId) => {
      setSelectedGroupId(null);
      invalidateAccessQueries(groupId);
      pushToast({ title: "Group deleted", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Group delete failed",
        body: getErrorMessage(err, "Unable to delete group."),
        tone: "error",
      }),
  });
  const updateGroupMembersMutation = useMutation({
    mutationFn: (input: { groupId: string; addUserIds?: string[]; removeUserIds?: string[] }) =>
      accessApi.updatePermissionGroupMembers(selectedCompanyId!, input.groupId, {
        addUserIds: input.addUserIds,
        removeUserIds: input.removeUserIds,
      }),
    onSuccess: (_members, variables) => invalidateAccessQueries(variables.groupId),
    onError: (err) =>
      pushToast({
        title: "Group members update failed",
        body: getErrorMessage(err, "Unable to update group members."),
        tone: "error",
      }),
  });
  const updateGroupPermissionsMutation = useMutation({
    mutationFn: ({ groupId, grants }: { groupId: string; grants: AccessGrantInput[] }) =>
      accessApi.updatePermissionGroupPermissions(selectedCompanyId!, groupId, grants),
    onSuccess: (_grants, variables) => invalidateAccessQueries(variables.groupId),
    onError: (err) =>
      pushToast({
        title: "Group permission update failed",
        body: getErrorMessage(err, "Unable to update group permissions."),
        tone: "error",
      }),
  });

  const groupMutationPending =
    updateGroupMutation.isPending ||
    deleteGroupMutation.isPending ||
    updateGroupMembersMutation.isPending ||
    updateGroupPermissionsMutation.isPending;
  const accessLoading = accessMembersQuery.isLoading || permissionGroupsQuery.isLoading;
  const accessError = accessMembersQuery.error ?? permissionGroupsQuery.error;
  const retryAccess = () => {
    void accessMembersQuery.refetch();
    void permissionGroupsQuery.refetch();
  };

  return {
    accessError,
    accessLoading,
    groupById,
    groupMutationPending,
    permissionGroups,
    selectedGroup,
    selectedGroupDetail,
    selectedGroupDetailQuery,
    userMembers,
    editingGroupDescription,
    editingGroupName,
    newGroupDescription,
    newGroupName,
    selectedGroupId,
    createGroupPending: createGroupMutation.isPending,
    updateMemberPermissionsPending: updateMemberPermissionsMutation.isPending,
    setEditingGroupDescription,
    setEditingGroupName,
    setNewGroupDescription,
    setNewGroupName,
    setSelectedGroupId,
    retryAccess,
    createGroup: () => createGroupMutation.mutate(),
    deleteSelectedGroup: () => {
      if (!selectedGroup) return;
      const confirmed = window.confirm(
        `Delete group "${selectedGroup.name}"? Its permissions and memberships will be removed.`
      );
      if (confirmed) deleteGroupMutation.mutate(selectedGroup.id);
    },
    saveSelectedGroup: () => {
      if (!selectedGroup) return;
      updateGroupMutation.mutate({
        groupId: selectedGroup.id,
        name: editingGroupName.trim(),
        description: editingGroupDescription.trim() || null,
      });
    },
    toggleGroupGrant: (permissionKey: PermissionKey, checked: boolean) => {
      if (!selectedGroupDetail) return;
      updateGroupPermissionsMutation.mutate({
        groupId: selectedGroupDetail.id,
        grants: toggleGrant(selectedGroupDetail.grants, permissionKey, checked),
      });
    },
    toggleGroupMember: (userId: string, checked: boolean) => {
      if (!selectedGroup) return;
      updateGroupMembersMutation.mutate({
        groupId: selectedGroup.id,
        addUserIds: checked ? [userId] : [],
        removeUserIds: checked ? [] : [userId],
      });
    },
    toggleGroupStatus: (status: "active" | "suspended") => {
      if (!selectedGroup) return;
      updateGroupMutation.mutate({ groupId: selectedGroup.id, status });
    },
    toggleUserGrant: (
      member: CompanyAccessMember,
      permissionKey: PermissionKey,
      checked: boolean
    ) =>
      updateMemberPermissionsMutation.mutate({
        memberId: member.id,
        grants: toggleGrant(member.grants, permissionKey, checked),
      }),
  };
}
