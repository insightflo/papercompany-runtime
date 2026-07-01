import { type JSX } from "react";
import type { StatusFilter, WorkflowScopeFilter } from "./workflow-page-types.js";
import { buttonStyle, filterTabStyle, inputStyle } from "./workflow-page-styles.js";
import { workflowFocusToolbarGroupStyle, workflowFocusToolbarStyle } from "./workflow-layout-styles.js";
import { HelpIcon } from "./shared-controls.js";

export function WorkflowDefinitionsToolbar({
  navigatorSearch,
  onNavigatorSearchChange,
  workflowScopeFilter,
  onWorkflowScopeFilterChange,
  workflowStatusFilter,
  onWorkflowStatusFilterChange,
  reusableCount,
  manualCount,
  activeCount,
  archivedCount,
  definitionsCollapsed,
  onToggleCollapsed,
}: {
  navigatorSearch: string;
  onNavigatorSearchChange: (value: string) => void;
  workflowScopeFilter: WorkflowScopeFilter;
  onWorkflowScopeFilterChange: (scope: WorkflowScopeFilter) => void;
  workflowStatusFilter: StatusFilter;
  onWorkflowStatusFilterChange: (status: StatusFilter) => void;
  reusableCount: number;
  manualCount: number;
  activeCount: number;
  archivedCount: number;
  definitionsCollapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  return (
        <div key="definitions-toolbar" style={{ ...workflowFocusToolbarStyle, flexShrink: 0, height: "fit-content" }}>
          <div key="definition-controls" style={workflowFocusToolbarGroupStyle}>
            <label key="navigator-search-field" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <input
                key="navigator-search"
                style={{ ...inputStyle, width: "200px", fontSize: "12px" }}
                value={navigatorSearch}
                onChange={(event) => onNavigatorSearchChange(event.target.value)}
                placeholder="Search workflows..."
                aria-label="Search workflows"
              />
              <HelpIcon label="Filters the workflow list by name, description, or related metadata." />
            </label>
          </div>
          <div key="scope-filter" style={workflowFocusToolbarGroupStyle}>
            <button key="reusable" type="button" style={filterTabStyle(workflowScopeFilter === "reusable")} onClick={() => onWorkflowScopeFilterChange("reusable")}>
              Reusable ({reusableCount})
            </button>
            <button key="manual-mission" type="button" style={filterTabStyle(workflowScopeFilter === "manual_mission")} onClick={() => onWorkflowScopeFilterChange("manual_mission")}>
              Manual ({manualCount})
            </button>
            <button key="active" type="button" style={filterTabStyle(workflowStatusFilter === "active")} onClick={() => onWorkflowStatusFilterChange("active")}>
              활성 ({activeCount})
            </button>
            <button key="archived" type="button" style={filterTabStyle(workflowStatusFilter === "archived")} onClick={() => onWorkflowStatusFilterChange("archived")}>
              보관 ({archivedCount})
            </button>
            <button
              key="collapse-toggle"
              type="button"
              style={buttonStyle}
              onClick={() => onToggleCollapsed()}
            >
              {definitionsCollapsed ? "▼" : "▲"}
            </button>
            <HelpIcon label="Use Reusable/Manual to switch workflow categories, Active/Archived to switch status, and the arrow to collapse this list." />
          </div>
        </div>

  );
}
