// [파일 목적] 그래프 인스펙터의 graph-group + flow-container 섹션 렌더.
// GraphInspector에서 두 구조 policy 섹션 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../step-draft.js, ../workflow-graph.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import { type WorkflowGraphContainerType } from "../workflow-graph.js";
import { buttonStyle, inputStyle, selectStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

type SelectedGroup = { title: string; color: string; collapsed?: boolean; collapsedByDefault?: boolean } | null;

// [목적] selected-step 의 graph group + flow container(branch/loop) 메타데이터 렌더.
// [입력] selectedStep + selectedGroup + group/container update·action 핸들러.
// [연결] GraphInspector <details> 내에서 렌더.
export function GraphInspectorPolicyStructure({
  selectedStep,
  selectedGroup,
  updateSelected,
  updateSelectedGroupMetadata,
  updateSelectedContainerMetadata,
  setSelectedGroupCollapsed,
  groupSelectedWithDependencies,
  clearSelectedGroup,
  wrapSelectedPathInContainer,
  clearSelectedContainer,
}: {
  selectedStep: StepDraft;
  selectedGroup: SelectedGroup;
  updateSelected: (patch: Partial<StepDraft>) => void;
  updateSelectedGroupMetadata: (patch: { title?: string; color?: string; collapsedByDefault?: boolean }) => void;
  updateSelectedContainerMetadata: (patch: Partial<StepDraft>) => void;
  setSelectedGroupCollapsed: (collapsed: boolean) => void;
  groupSelectedWithDependencies: () => void;
  clearSelectedGroup: () => void;
  wrapSelectedPathInContainer: () => void;
  clearSelectedContainer: () => void;
}): JSX.Element {
  return (
    <Fragment>
            <div key="graph-group" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Visual grouping metadata used to organize graph nodes.">Graph group</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Group id shared by steps that should appear in the same visual group.">Group ID</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphGroupId}
                  placeholder="group-id"
                  onChange={(event) => updateSelected({ graphGroupId: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Human-readable title shown on the group frame.">Group title</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedGroup?.title ?? selectedStep.graphGroupTitle}
                  placeholder="Group title"
                  onChange={(event) => updateSelectedGroupMetadata({ title: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Accent color used for the visual group.">Group color</FieldLabel>
                <input
                  type="color"
                  style={{ ...inputStyle, height: "36px", padding: "4px" }}
                  value={(selectedGroup?.color ?? selectedStep.graphGroupColor) || "#64748b"}
                  onChange={(event) => updateSelectedGroupMetadata({ color: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedGroup?.collapsedByDefault ?? selectedStep.graphGroupCollapsedByDefault}
                  onChange={(event) => updateSelectedGroupMetadata({ collapsedByDefault: event.target.checked })}
                />
                Collapsed by default
                <HelpIcon label="Starts this group collapsed when the graph first renders." />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={groupSelectedWithDependencies}>
                  Group with upstream steps
                </button>
                <HelpIcon label="Creates or updates a group that includes the selected step and its upstream dependencies." />
              </div>
              {selectedStep.graphGroupId.trim() ? (
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={() => setSelectedGroupCollapsed(!(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false))}
                  >
                    {(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false) ? "Expand selected group" : "Collapse selected group"}
                  </button>
                  <HelpIcon label="Temporarily toggles visibility for the selected group in the graph canvas." />
                </div>
              ) : (
                <Fragment key="collapse-group-placeholder" />
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={clearSelectedGroup}>
                  Clear selected group
                </button>
                <HelpIcon label="Removes the selected step from its current visual group." />
              </div>
            </div>
            <div key="flow-container" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <HelpedText help="Branch and loop metadata that controls grouped execution paths in the graph.">Flow container</HelpedText>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Container type: branch selects conditional paths; loop repeats over items or conditions.">Container type</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphContainerType}
                  onChange={(event) => updateSelectedContainerMetadata({
                    graphContainerType: event.target.value as WorkflowGraphContainerType,
                    graphContainerMode: event.target.value === "loop" ? "for-each" : "branch-one",
                  })}
                >
                  <option value="branch">Branch</option>
                  <option value="loop">Loop</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Container id shared by all steps inside the same branch or loop.">Container ID</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphContainerId}
                  placeholder="container-id"
                  onChange={(event) => updateSelected({ graphContainerId: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Human-readable title shown for the branch or loop container.">Container title</FieldLabel>
                <input
                  style={inputStyle}
                  value={selectedStep.graphContainerTitle}
                  placeholder="Container title"
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerTitle: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Short description of what this branch or loop is responsible for.">Container description</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "64px" }}
                  value={selectedStep.graphContainerDescription}
                  placeholder="Container description"
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerDescription: event.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Execution mode inside this container, such as first matching branch or all matching branches.">Container mode</FieldLabel>
                <select
                  style={selectStyle}
                  value={selectedStep.graphContainerMode || (selectedStep.graphContainerType === "loop" ? "for-each" : "branch-one")}
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerMode: event.target.value })}
                >
                  {selectedStep.graphContainerType === "loop" ? [
                    <option key="for-each" value="for-each">For each</option>,
                    <option key="while" value="while">While</option>,
                  ] : [
                    <option key="branch-one" value="branch-one">Run first matching branch</option>,
                    <option key="branch-all" value="branch-all">Run all matching branches</option>,
                  ]}
                </select>
              </div>
              {selectedStep.graphContainerType === "branch" ? (
                <div key="branch-condition-field" style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Condition expression that decides whether this branch path should run.">Branch condition</FieldLabel>
                  <textarea
                    key="branch-condition"
                    style={{ ...textareaStyle, minHeight: "58px" }}
                    value={selectedStep.graphContainerCondition}
                    placeholder="Branch condition"
                    onChange={(event) => updateSelectedContainerMetadata({ graphContainerCondition: event.target.value })}
                  />
                </div>
              ) : (
                <Fragment key="loop-settings">
                  <div key="iterator-field" style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Expression that returns the items or condition used by this loop.">Iterator expression</FieldLabel>
                    <textarea
                      key="iterator"
                      style={{ ...textareaStyle, minHeight: "58px" }}
                      value={selectedStep.graphContainerIterator}
                      placeholder="Iterator expression"
                      onChange={(event) => updateSelectedContainerMetadata({ graphContainerIterator: event.target.value })}
                    />
                  </div>
                  <div key="loop-toggles" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    <label key="parallel" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerRunInParallel}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerRunInParallel: event.target.checked })}
                      />
                      Run in parallel
                      <HelpIcon label="Runs loop iterations concurrently instead of one at a time." />
                    </label>
                    <label key="skip-failure" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerSkipFailure}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerSkipFailure: event.target.checked })}
                      />
                      Skip failure
                      <HelpIcon label="Allows later iterations or branches to continue when one path fails." />
                    </label>
                  </div>
                  <div key="parallelism-field" style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Maximum concurrent loop iterations when parallel mode is enabled.">Parallelism</FieldLabel>
                    <input
                      key="parallelism"
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphContainerParallelism}
                      placeholder="parallelism"
                      onChange={(event) => updateSelectedContainerMetadata({ graphContainerParallelism: event.target.value })}
                    />
                  </div>
                </Fragment>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button key="wrap" type="button" style={buttonStyle} onClick={wrapSelectedPathInContainer}>
                  Wrap selected path
                </button>
                <HelpIcon label="Places the currently selected path into the configured branch or loop container." />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <button key="clear" type="button" style={buttonStyle} onClick={clearSelectedContainer}>
                  Clear selected container
                </button>
                <HelpIcon label="Removes the selected step from its branch or loop container." />
              </div>
            </div>

    </Fragment>
  );
}
