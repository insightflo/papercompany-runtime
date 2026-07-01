import * as React from "react";
import { useEffect, useRef, useState, useCallback, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import { buildMissionHref } from "./routes.js";
import { buttonDisabledStyle, buttonStyle, helpIconStyle, helpTooltipStyle, mutedTextStyle, sectionStyle } from "./workflow-page-styles.js";

export function currentBrowserPathname(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.pathname;
}

export function MissionRunLink({ missionId }: { missionId?: string | null }): JSX.Element | null {
  if (!missionId) return null;
  return (
    <a
      href={buildMissionHref({
        missionId,
        currentPathname: currentBrowserPathname(),
      })}
      style={{ ...buttonStyle, textDecoration: "none" }}
      title={missionId}
    >
      Mission
    </a>
  );
}

export function HelpIcon({ label }: { label: string }): JSX.Element {
  const tooltipId = React.useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "above" | "below" }>({
    left: 8,
    top: 8,
    placement: "below",
  });

  const updatePosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tooltipWidth = Math.min(280, Math.max(120, window.innerWidth - 16));
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - tooltipWidth / 2), Math.max(8, window.innerWidth - tooltipWidth - 8));
    const shouldOpenAbove = rect.bottom + 92 > window.innerHeight && rect.top > 112;
    setPosition({
      left,
      top: shouldOpenAbove ? rect.top - 8 : rect.bottom + 8,
      placement: shouldOpenAbove ? "above" : "below",
    });
  }, []);

  const showTooltip = useCallback(() => {
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  const closeTooltip = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open || typeof window === "undefined" || typeof document === "undefined") return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTooltip();
      }
    };
    const handleViewportChange = () => updatePosition();

    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeTooltip, open, updatePosition]);

  const tooltip = open && typeof document !== "undefined"
    ? createPortal(
      <div
        id={tooltipId}
        role="tooltip"
        style={{
          ...helpTooltipStyle,
          left: `${position.left}px`,
          top: `${position.top}px`,
          transform: position.placement === "above" ? "translateY(-100%)" : undefined,
        }}
      >
        {label}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        aria-label={label}
        style={{
          ...helpIconStyle,
          borderColor: open ? "color-mix(in srgb, #38bdf8 56%, var(--border, #334155))" : "var(--border, #334155)",
          color: open ? "#bae6fd" : helpIconStyle.color,
          background: open ? "color-mix(in srgb, #38bdf8 14%, transparent)" : "transparent",
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            showTooltip();
          }
        }}
        onBlur={closeTooltip}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            closeTooltip();
          }
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" || event.pointerType === "pen") {
            showTooltip();
          }
        }}
        onPointerLeave={closeTooltip}
      >
        ?
      </button>
      {tooltip}
    </>
  );
}

export function FieldLabel({ children, help }: { children: React.ReactNode; help: string }): JSX.Element {
  return (
    <label style={{ ...mutedTextStyle, display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px" }}>
      <span>{children}</span>
      <HelpIcon label={help} />
    </label>
  );
}

export function HelpedText({
  children,
  help,
  style,
}: {
  children: React.ReactNode;
  help: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <span style={{ ...mutedTextStyle, display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", ...style }}>
      <span>{children}</span>
      <HelpIcon label={help} />
    </span>
  );
}

export function ErrorState({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => Promise<void>;
  retrying: boolean;
}): JSX.Element {
  return (
    <div style={sectionStyle}>
      <p style={mutedTextStyle}>{message}</p>
      <div>
        <button
          onClick={() => {
            void onRetry();
          }}
          style={retrying ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          type="button"
          disabled={retrying}
        >
          {retrying ? "갱신 중..." : "Retry"}
        </button>
      </div>
    </div>
  );
}
