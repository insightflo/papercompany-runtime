import { useEffect, useRef, useState } from "react";
import type {
  OperatorDecisionAction,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";
import type { ResolveOperatorDecisionInput } from "../api/operator-decisions";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

interface OperatorDecisionCardProps {
  decision: OperatorDecisionView;
  onResolve: (decisionId: string, input: ResolveOperatorDecisionInput) => Promise<unknown>;
}

function toneClass(tone: OperatorDecisionAction["tone"]) {
  if (tone === "danger") return "border-destructive text-destructive hover:bg-destructive/10";
  if (tone === "primary") return "border-primary bg-primary text-primary-foreground hover:bg-primary/90";
  return "border-border bg-background text-foreground hover:bg-accent";
}

function sourceLabel(decision: OperatorDecisionView) {
  if (!decision.requestedBy) return "System";
  return `${decision.requestedBy.type === "agent" ? "Agent" : "Board"} ${decision.requestedBy.id.slice(0, 8)}`;
}

export function OperatorDecisionCard({ decision, onResolve }: OperatorDecisionCardProps) {
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittingActionId, setSubmittingActionId] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const descriptionId = `operator-decision-${decision.id}-description`;
  const errorId = `operator-decision-${decision.id}-error`;
  const commentId = `operator-decision-${decision.id}-comment`;

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function toggleOption(id: string) {
    setError(null);
    if (decision.interactionType === "single_select") {
      setSelectedOptionIds([id]);
      return;
    }
    setSelectedOptionIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
  }

  function localError(action: OperatorDecisionAction): string | null {
    if (action.requiresSelection) {
      const bounds = decision.definition.selection;
      if (!bounds) return "This action cannot accept a selection.";
      if (selectedOptionIds.length < bounds.min || selectedOptionIds.length > bounds.max) {
        return bounds.min === bounds.max
          ? `Select ${bounds.min} option${bounds.min === 1 ? "" : "s"}.`
          : `Select between ${bounds.min} and ${bounds.max} options.`;
      }
    }
    const trimmed = comment.trim();
    if (decision.definition.comment.mode === "required" && !trimmed) return "A comment is required.";
    if (trimmed.length > decision.definition.comment.maxLength) {
      return `Comment must be ${decision.definition.comment.maxLength} characters or fewer.`;
    }
    return null;
  }

  async function submit(action: OperatorDecisionAction) {
    const validationError = localError(action);
    if (validationError) {
      setError(validationError);
      return;
    }
    const trimmedComment = comment.trim();
    const input: ResolveOperatorDecisionInput = {
      actionId: action.id,
      selectedOptionIds: action.requiresSelection ? selectedOptionIds : [],
      comment: decision.definition.comment.mode === "disabled" || !trimmedComment ? null : trimmedComment,
    };
    setError(null);
    setSubmittingActionId(action.id);
    try {
      await onResolve(decision.id, input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to resolve this Interactive Card.");
    } finally {
      setSubmittingActionId(null);
    }
  }

  return (
    <article className="border border-border bg-card p-4" aria-labelledby={`operator-decision-${decision.id}-heading`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold uppercase text-foreground">{decision.priority}</span>
        <span>Requested by {sourceLabel(decision)}</span>
        <span>{timeAgo(decision.createdAt)}</span>
      </div>
      <h2
        id={`operator-decision-${decision.id}-heading`}
        data-operator-decision-heading
        tabIndex={-1}
        className="mt-2 text-base font-semibold"
      >
        {decision.title}
      </h2>
      <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{decision.description}</p>

      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        {decision.issueId && <a href={`/issues/${decision.issueId}`}>Open linked work</a>}
        {decision.sourceContext.missionId && <a href={`/missions/${decision.sourceContext.missionId}`}>Open mission</a>}
        {decision.sourceContext.artifactRefs.map((ref) => (
          ref.uri.startsWith("http:") || ref.uri.startsWith("https:")
            ? <a key={ref.uri} href={ref.uri} target="_blank" rel="noreferrer">{ref.label}</a>
            : <span key={ref.uri}>{ref.label}</span>
        ))}
      </div>

      {decision.interactionType !== "action" && (
        <fieldset className="mt-4 space-y-2" aria-describedby={`${descriptionId} ${errorId}`}>
          <legend className="text-sm font-medium">Options</legend>
          {decision.definition.options.map((option) => {
            const checked = selectedOptionIds.includes(option.id);
            return (
              <label key={option.id} className="block cursor-pointer border border-border p-3 has-[:checked]:border-primary">
                <span className="flex items-start gap-2">
                  <input
                    type={decision.interactionType === "single_select" ? "radio" : "checkbox"}
                    name={`operator-decision-${decision.id}-options`}
                    value={option.id}
                    checked={checked}
                    onChange={() => toggleOption(option.id)}
                    disabled={submittingActionId !== null}
                    aria-describedby={`${descriptionId} ${errorId}`}
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </span>
                {option.facts.length > 0 && (
                  <dl className="mt-2 grid gap-1 text-xs">
                    {option.facts.map((fact) => (
                      <div key={`${fact.label}:${fact.value}`} className="flex gap-2">
                        <dt>{fact.label}</dt><dd>{fact.value} ({fact.status})</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {option.evidenceRefs.map((ref) => (
                  <a key={ref.href} className="mt-2 block text-xs" href={ref.href} target="_blank" rel="noreferrer">
                    {ref.label}
                  </a>
                ))}
              </label>
            );
          })}
        </fieldset>
      )}

      {(decision.definition.approvedScope.length > 0 || decision.definition.forbiddenScope.length > 0) && (
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
          <div><strong>Approved scope</strong><ul>{decision.definition.approvedScope.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><strong>Forbidden scope</strong><ul>{decision.definition.forbiddenScope.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>
      )}

      {decision.definition.comment.mode !== "disabled" && (
        <div className="mt-4">
          <label htmlFor={commentId} className="text-sm font-medium">{decision.definition.comment.label}</label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={decision.definition.comment.placeholder ?? undefined}
            maxLength={decision.definition.comment.maxLength}
            required={decision.definition.comment.mode === "required"}
            aria-describedby={`${descriptionId} ${errorId}`}
            disabled={submittingActionId !== null}
            className="mt-1 min-h-20 w-full border border-border bg-background p-2 text-sm"
          />
        </div>
      )}

      <div ref={errorRef} id={errorId} role="alert" aria-live="assertive" tabIndex={-1} className="mt-3 text-sm text-destructive">
        {error}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {decision.definition.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void submit(action)}
            disabled={submittingActionId !== null}
            className={cn("border px-3 py-2 text-sm font-medium disabled:opacity-50", toneClass(action.tone))}
          >
            {submittingActionId === action.id ? "Submitting…" : action.label}
          </button>
        ))}
      </div>
    </article>
  );
}
