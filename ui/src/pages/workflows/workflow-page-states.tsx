import { type JSX } from "react";
import { buttonDisabledStyle, buttonStyle, headerRowStyle, mutedTextStyle, pageStyle, titleStyle } from "./workflow-page-styles.js";
import { ErrorState } from "./shared-controls.js";

export function WorkflowLoadingState({
  pluginId,
  isRefreshing,
  refreshButtonLabel,
  onRefresh,
}: {
  pluginId: string;
  isRefreshing: boolean;
  refreshButtonLabel: string;
  onRefresh: () => void;
}): JSX.Element {
  return (
      <div data-plugin-id={pluginId} style={pageStyle}>
        <div key="workflow-page-header" style={headerRowStyle}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void onRefresh();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
        </div>
        <p key="loading" style={mutedTextStyle}>Loading workflows...</p>
      </div>
  );
}

export function WorkflowErrorState({
  pluginId,
  isRefreshing,
  refreshButtonLabel,
  onRefresh,
  message,
  onRetry,
}: {
  pluginId: string;
  isRefreshing: boolean;
  refreshButtonLabel: string;
  onRefresh: () => void;
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
      <div data-plugin-id={pluginId} style={pageStyle}>
        <div key="workflow-page-header" style={headerRowStyle}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void onRefresh();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
        </div>
        <ErrorState
          key="error-state"
          message={message}
          onRetry={() => Promise.resolve(onRetry())}
          retrying={isRefreshing}
        />
      </div>
  );
}
