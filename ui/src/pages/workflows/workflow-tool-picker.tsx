import { type CSSProperties, type JSX } from "react";
import type { WorkflowToolOption } from "./workflow-page-types.js";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle, selectStyle } from "./workflow-page-styles.js";

export function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function toggleCommaListValue(value: string, item: string): string {
  const selected = splitCommaList(value);
  const next = selected.includes(item)
    ? selected.filter((entry) => entry !== item)
    : [...selected, item];
  return next.join(", ");
}

export function toolChoiceChipStyle(selected: boolean): CSSProperties {
  return {
    ...buttonStyle,
    width: "auto",
    justifyContent: "flex-start",
    padding: "6px 8px",
    fontSize: "11px",
    borderColor: selected ? "#38bdf8" : "var(--border, #334155)",
    background: selected
      ? "color-mix(in srgb, #38bdf8 18%, var(--background, #020617))"
      : "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
    color: selected ? "#bae6fd" : "var(--foreground, #f8fafc)",
  };
}

export function WorkflowToolPicker({
  value,
  multiple,
  tools,
  onChange,
}: {
  value: string;
  multiple: boolean;
  tools: WorkflowToolOption[];
  onChange: (value: string) => void;
}): JSX.Element {
  const selectedValues = multiple ? splitCommaList(value) : [value.trim()].filter(Boolean);
  const availableNames = new Set(tools.map((tool) => tool.name));
  const unavailableSelections = selectedValues.filter((toolName) => !availableNames.has(toolName));

  if (!multiple) {
    return (
      <div style={{ display: "grid", gap: "5px" }}>
        <select style={selectStyle} value={value.trim()} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose authorized tool</option>
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.displayName || tool.name}
            </option>
          ))}
          {unavailableSelections.map((toolName) => (
            <option key={`unavailable-${toolName}`} value={toolName}>
              {toolName} (unavailable)
            </option>
          ))}
        </select>
        {value.trim() ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", overflowWrap: "anywhere" }}>
            {tools.find((tool) => tool.name === value.trim())?.description || "Selected workflow tool"}
          </span>
        ) : (
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Select one authorized tool for this tool step.</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "6px" }}>
      {tools.length > 0 ? (
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {tools.map((tool) => {
            const selected = selectedValues.includes(tool.name);
            return (
              <button
                key={tool.name}
                type="button"
                title={tool.description || tool.name}
                style={toolChoiceChipStyle(selected)}
                onClick={() => onChange(toggleCommaListValue(value, tool.name))}
              >
                {selected ? "✓ " : ""}
                {tool.displayName || tool.name}
              </button>
            );
          })}
        </div>
      ) : (
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>No authorized tools available.</span>
      )}
      {unavailableSelections.length > 0 ? (
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {unavailableSelections.map((toolName) => (
            <span key={toolName} style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>
              {toolName} unavailable
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
