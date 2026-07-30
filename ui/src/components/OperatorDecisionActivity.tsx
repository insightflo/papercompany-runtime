import type { ActivityEvent } from "@paperclipai/shared";
import { timeAgo } from "../lib/timeAgo";

const actionLabels: Record<string, string> = {
  "operator_decision.created": "Interactive Card created",
  "operator_decision.resolved": "Interactive Card resolved",
  "operator_decision.cancelled": "Interactive Card cancelled",
  "operator_decision.continuation_accepted": "Continuation queued",
  "operator_decision.continuation_blocked": "Continuation blocked",
  "operator_decision.continuation_exhausted": "Continuation exhausted",
  "operator_decision.continuation_retried": "Continuation retried",
};

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/_/g, " ") : null;
}
function number(value: unknown) {
  return typeof value === "number" ? value : null;
}
function list(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function EventDetails({ event }: { event: ActivityEvent }) {
  const details = event.details ?? {};
  if (event.action === "operator_decision.created") {
    return <p>{text(details.priority)} · {text(details.interactionType)} · {text(details.sourceType)}</p>;
  }
  if (event.action === "operator_decision.resolved") {
    const selected = list(details.selectedOptionIds);
    return <p>
      Action {text(details.actionId)} · outcome {text(details.outcome)}
      {selected.length > 0 ? ` · selected ${selected.join(", ")}` : " · no selection"}
      {details.commentPresent === true ? " · Comment provided" : " · No comment"}
    </p>;
  }
  if (event.action === "operator_decision.cancelled") {
    return <p>Cancelled by {text(details.cancelledByActorType)} {text(details.cancelledByActorId)}</p>;
  }
  if (event.action === "operator_decision.continuation_retried") {
    return <p>
      Generation {number(details.previousGeneration)} → {number(details.newGeneration)} · previous {text(details.previousEffectiveStatus)}
    </p>;
  }
  if (event.action.startsWith("operator_decision.continuation_")) {
    return <p>
      {text(details.effectiveStatus)}{details.errorCode ? ` · ${text(details.errorCode)}` : ""}
      {` · Generation ${number(details.generation)} · attempt ${number(details.attempt)}`}
    </p>;
  }
  return null;
}

export function OperatorDecisionActivity({ event }: { event: ActivityEvent }) {
  return (
    <article className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{actionLabels[event.action] ?? "Interactive Card event"}</h3>
          <div className="mt-1 text-xs text-muted-foreground"><EventDetails event={event} /></div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span>
      </div>
    </article>
  );
}
