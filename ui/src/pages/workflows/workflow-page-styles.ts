import type { CSSProperties } from "react";

export const pageStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
  padding: "5px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "var(--foreground, #f8fafc)",
};

export const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "12px",
  background: "var(--card, #0f172a)",
};

export const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
};

export const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "28px",
  lineHeight: 1.2,
  fontWeight: 700,
};

export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "18px",
  lineHeight: 1.3,
  fontWeight: 600,
};

export const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "14px",
  lineHeight: 1.5,
};

export const noticeStyle = (tone: "info" | "error" | "success"): CSSProperties => ({
  ...mutedTextStyle,
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  color: tone === "error" ? "#fca5a5" : tone === "success" ? "#86efac" : "var(--muted-foreground, #94a3b8)",
  background: tone === "error"
    ? "rgba(127, 29, 29, 0.18)"
    : tone === "success"
      ? "rgba(20, 83, 45, 0.18)"
      : "rgba(15, 23, 42, 0.6)",
});

export const highlightedRunRowStyle: CSSProperties = {
  background: "color-mix(in srgb, #22c55e 14%, transparent)",
  boxShadow: "inset 3px 0 0 #22c55e",
};

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

export const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #334155)",
  textAlign: "left",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--muted-foreground, #94a3b8)",
};

export const tdStyle: CSSProperties = {
  padding: "12px",
  borderBottom: "1px solid var(--border, #334155)",
  verticalAlign: "top",
};

export const widgetStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "14px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "12px",
  background: "var(--card, #0f172a)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "var(--foreground, #f8fafc)",
};

export const widgetTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "14px",
  lineHeight: 1.2,
  fontWeight: 600,
};

export const widgetCountStyle: CSSProperties = {
  fontSize: "28px",
  lineHeight: 1,
  fontWeight: 700,
};

export const badgeRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
};

export const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "13px",
};

export const buttonDisabledStyle: CSSProperties = {
  opacity: 0.65,
  cursor: "not-allowed",
};

export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "color-mix(in srgb, var(--foreground, #f8fafc) 14%, var(--card, #0f172a))",
};

export const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 24%, var(--card, #0f172a))",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "13px",
};

export const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "150px",
  resize: "vertical",
};

export const helpIconStyle: CSSProperties = {
  appearance: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "16px",
  height: "16px",
  padding: 0,
  border: "1px solid var(--border, #334155)",
  borderRadius: "50%",
  background: "transparent",
  color: "var(--muted-foreground, #94a3b8)",
  fontFamily: "inherit",
  fontSize: "11px",
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  flex: "0 0 auto",
  position: "relative",
  userSelect: "none",
};

export const helpTooltipStyle: CSSProperties = {
  position: "fixed",
  zIndex: 10000,
  width: "min(280px, calc(100vw - 16px))",
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--popover, #020617) 94%, var(--background, #020617))",
  color: "var(--popover-foreground, var(--foreground, #f8fafc))",
  boxShadow: "0 12px 28px rgba(2, 6, 23, 0.42)",
  fontSize: "12px",
  fontWeight: 500,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
  pointerEvents: "auto",
};

export const paginationBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  marginTop: "12px",
};

export const paginationInfoStyle: CSSProperties = {
  ...mutedTextStyle,
  fontSize: "12px",
};

export const filterTabStyle = (isActive: boolean): CSSProperties => ({
  padding: "6px 14px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "6px",
  background: isActive
    ? "color-mix(in srgb, var(--foreground, #f8fafc) 14%, var(--card, #0f172a))"
    : "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: isActive ? 700 : 500,
  opacity: isActive ? 1 : 0.7,
});

export const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: "none",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  paddingRight: "28px",
};

export const graphPolicyBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  maxWidth: "100%",
  padding: "2px 5px",
  border: "1px solid color-mix(in srgb, var(--muted-foreground, #94a3b8) 32%, transparent)",
  borderRadius: "999px",
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "10px",
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function statusBadgeStyle(status: string): CSSProperties {
  const normalized = status.trim().toLowerCase();
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    border: "1px solid var(--border, #334155)",
    color: "var(--foreground, #f8fafc)",
  };

  if (normalized === "running" || normalized === "active") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--foreground, #f8fafc) 16%, var(--background, #020617))",
    };
  }

  if (normalized === "completed") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--foreground, #f8fafc) 22%, var(--background, #020617))",
    };
  }

  if (normalized === "succeeded" || normalized === "success" || normalized === "done") {
    return {
      ...base,
      background: "color-mix(in srgb, #22c55e 22%, var(--background, #020617))",
    };
  }

  if (normalized === "failed" || normalized === "aborted") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 26%, var(--background, #020617))",
    };
  }

  if (normalized === "timed-out" || normalized === "paused") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 20%, var(--background, #020617))",
    };
  }

  if (normalized === "skipped") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 14%, var(--background, #020617))",
    };
  }

  return {
    ...base,
    background: "color-mix(in srgb, var(--background, #020617) 78%, var(--card, #0f172a))",
  };
}
