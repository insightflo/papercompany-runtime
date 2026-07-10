// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccessUsersView } from "./AccessUsersView";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

const groupById = new Map<string, { id: string; name: string }>();

describe("AccessUsersView member picker", () => {
  it("renders the add-user search control and empty prompt", () => {
    const html = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery=""
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(html).toContain("Add user");
    expect(html).toContain("Search active users by name or email");
    expect(html).toContain("No human users have access to this company yet.");
  });

  it("renders loading, selectable result, and selected add state", () => {
    const loadingHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={true}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );
    const selectedHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[{ id: "user-2", name: "Candidate Cora", email: "candidate@example.com" }]}
        searchLoading={false}
        searchError={null}
        selectedUserId="user-2"
        onSelectUser={vi.fn()}
        addUserPending={true}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(loadingHtml).toContain("Searching users...");
    expect(selectedHtml).toContain("Candidate Cora");
    expect(selectedHtml).toContain("candidate@example.com");
    expect(selectedHtml).toContain("Adding...");
  });

  it("renders search errors and no-result state", () => {
    const errorHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={new Error("Search failed")}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );
    const emptyResultHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="missing"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(errorHtml).toContain("Search failed");
    expect(emptyResultHtml).toContain("No matching users available.");
  });
});
