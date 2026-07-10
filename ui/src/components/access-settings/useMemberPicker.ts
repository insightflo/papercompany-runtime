import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { accessApi } from "../../api/access";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "./utils";

export function useMemberPicker(selectedCompanyId: string | null, onAdded: () => void) {
  const { pushToast } = useToast();
  const [memberSearchQuery, setMemberSearchQuery] = useState("");
  const [debouncedMemberSearchQuery, setDebouncedMemberSearchQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedMemberSearchQuery(memberSearchQuery.trim());
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [memberSearchQuery]);

  const memberSearchQueryValue = debouncedMemberSearchQuery.trim();
  const memberSearchQueryResult = useQuery({
    queryKey:
      selectedCompanyId && memberSearchQueryValue
        ? queryKeys.access.memberSearch(selectedCompanyId, memberSearchQueryValue)
        : ["access", "member-search", "__no-company__", "__no-query__"],
    queryFn: () => accessApi.searchUsers(selectedCompanyId!, memberSearchQueryValue, 10),
    enabled: !!selectedCompanyId && memberSearchQueryValue.length > 0,
  });

  useEffect(() => {
    setMemberSearchQuery("");
    setDebouncedMemberSearchQuery("");
    setSelectedUserId(null);
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedUserId) return;
    const stillVisible = memberSearchQueryResult.data?.some((user) => user.id === selectedUserId);
    if (stillVisible === false) setSelectedUserId(null);
  }, [memberSearchQueryResult.data, selectedUserId]);

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => accessApi.addMember(selectedCompanyId!, userId),
    onSuccess: (membership) => {
      setMemberSearchQuery("");
      setDebouncedMemberSearchQuery("");
      setSelectedUserId(null);
      onAdded();
      pushToast({
        title: "User added",
        body: membership.principalId,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "User add failed",
        body: getErrorMessage(err, "Unable to add user."),
        tone: "error",
      }),
  });

  const changeMemberSearchQuery = (value: string) => {
    setMemberSearchQuery(value);
    setSelectedUserId(null);
  };

  return {
    memberSearchQuery,
    memberSearchResults: memberSearchQueryResult.data ?? [],
    memberSearchLoading: memberSearchQueryResult.isFetching,
    memberSearchError: memberSearchQueryResult.error,
    selectedUserId,
    addMemberPending: addMemberMutation.isPending,
    setMemberSearchQuery: changeMemberSearchQuery,
    setSelectedUserId,
    addSelectedMember: () => {
      if (!selectedUserId) return;
      addMemberMutation.mutate(selectedUserId);
    },
  };
}
