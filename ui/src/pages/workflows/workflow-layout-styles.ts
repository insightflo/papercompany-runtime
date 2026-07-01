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
