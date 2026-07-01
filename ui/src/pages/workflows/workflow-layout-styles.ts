import { type CSSProperties } from "react";

export const workflowFocusSectionStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 58%, var(--background, #020617))",
};

export const workflowFocusToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  flexWrap: "wrap",
};

export const workflowFocusToolbarGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexWrap: "wrap",
  minWidth: 0,
};

export const formPanelStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
};

export const workflowCreateShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto auto minmax(560px, 1fr) auto auto",
  gap: 0,
  minHeight: "760px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
  overflow: "hidden",
};

export const workflowCreateHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
  padding: "12px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 44%, var(--card, #0f172a))",
  flexWrap: "wrap",
};

export const workflowCreateIdentityStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.8fr) minmax(260px, 1.2fr)",
  gap: "10px",
  flex: "1 1 560px",
  minWidth: 0,
};

export const workflowCreateActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "8px",
  flexWrap: "wrap",
};

export const workflowCreateSetupStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: "8px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
};

export const workflowCreateFieldStyle: CSSProperties = {
  display: "grid",
  gap: "4px",
  minWidth: 0,
};

export const workflowCreateWorkspaceStyle: CSSProperties = {
  display: "grid",
  minHeight: 0,
  padding: "12px",
};

export const workflowManagementShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "280px minmax(640px, 1fr)",
  gap: "0",
  minHeight: "620px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  overflow: "hidden",
  background: "var(--background, #020617)",
};

export const workflowSelectedHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "8px 12px",
  alignItems: "center",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 90%, var(--card, #0f172a))",
};

export const workflowSelectedIdentityStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.8fr) minmax(280px, 1.2fr)",
  gap: "8px",
  minWidth: 0,
};

export const workflowSelectedSetupStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
  gap: "8px",
  gridColumn: "1 / -1",
  paddingTop: "8px",
  borderTop: "1px solid var(--border, #334155)",
};

export const workflowSelectedWorkspaceStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
};

export const workflowSelectedEditorStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  gap: "0",
  minWidth: 0,
  minHeight: 0,
};
