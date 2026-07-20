import type { JSX, PointerEvent, MouseEvent } from "react";
import type { PendingWorkflowConnection } from "../workflow-control-nodes.js";
import {
  graphNodeInputHandleStyle,
  graphNodeOutputHandleStyle,
} from "./graphStyles.js";

type HandleStep = {
  id: string;
  type?: string;
};

export function GraphNodeHandles({
  step,
  pendingConnection,
  beginEdgeConnection,
  completeEdgeConnection,
}: {
  step: HandleStep;
  pendingConnection: PendingWorkflowConnection | null;
  beginEdgeConnection: (event: PointerEvent<HTMLElement>, connection: PendingWorkflowConnection) => void;
  completeEdgeConnection: (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>, targetId: string) => void;
}): JSX.Element {
  const canReceive = Boolean(pendingConnection && pendingConnection.sourceStepId !== step.id);
  const output = (
    when: PendingWorkflowConnection["when"],
    label: string,
    top = "50%",
  ) => (
    <span key={when}>
      <span
        data-graph-handle="true"
        data-graph-handle-kind="output"
        data-graph-handle-id={when}
        data-step-id={step.id}
        aria-label={`Start ${label} from ${step.id}`}
        title={`Start ${label} from ${step.id}`}
        style={{
          ...graphNodeOutputHandleStyle(
            pendingConnection?.sourceStepId === step.id && pendingConnection.when === when,
          ),
          top,
          background: when === "condition_false" ? "#f97316" : when === "condition_true" ? "#22c55e" : undefined,
        }}
        onPointerDown={(event) => beginEdgeConnection(event, { sourceStepId: step.id, when })}
        onPointerUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      {step.type === "if" ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: "10px",
            top,
            transform: "translateY(-50%)",
            color: when === "condition_true" ? "#22c55e" : "#fb923c",
            fontSize: "9px",
            fontWeight: 800,
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      ) : null}
    </span>
  );

  return (
    <>
      <span
        data-graph-handle="true"
        data-graph-handle-kind="input"
        data-graph-handle-id="input"
        data-step-id={step.id}
        aria-label={pendingConnection ? `Connect to ${step.id}` : `Input for ${step.id}`}
        title={pendingConnection ? `Connect to ${step.id}` : `Input: ${step.id}`}
        style={graphNodeInputHandleStyle(canReceive)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerUp={(event) => completeEdgeConnection(event, step.id)}
        onClick={(event) => completeEdgeConnection(event, step.id)}
      />
      {step.type === "complete" ? null : step.type === "if" ? (
        <>
          {output("condition_true", "true branch", "32%")}
          {output("condition_false", "false branch", "70%")}
        </>
      ) : output("success", "relationship")}
    </>
  );
}
