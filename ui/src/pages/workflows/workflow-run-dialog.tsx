import { useId, useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorkflowRunInputFieldError } from "@paperclipai/shared/workflow-run-input-values";
import type { WorkflowOverviewData } from "./workflow-page-types.js";
import { collectWorkflowRunInputDraft, initialWorkflowRunInputDraft, type WorkflowRunSubmission } from "./workflow-run-inputs.js";
import { workflowRunInputErrorsFromApi } from "./workflow-run-dialog-errors.js";
import { WorkflowRunInputField } from "./workflow-run-input-field.js";

export function WorkflowRunDialog({ workflow, onCancel, onSubmit }: {
  workflow: Pick<WorkflowOverviewData["workflows"][number], "id" | "name" | "runInputs">;
  onCancel: () => void;
  onSubmit: (input: WorkflowRunSubmission) => Promise<void>;
}): JSX.Element {
  const inputs = workflow.runInputs ?? [];
  const [draft, setDraft] = useState(() => initialWorkflowRunInputDraft(inputs));
  const [runLabel, setRunLabel] = useState("");
  const [fieldErrors, setFieldErrors] = useState<WorkflowRunInputFieldError[]>([]);
  const [generalError, setGeneralError] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  // The table's Run buttons live outside this conditional Dialog root.
  const [trigger] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null);

  function cancel(): void {
    if (!submitting.current) onCancel();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    setGeneralError("");
    const collected = collectWorkflowRunInputDraft(inputs, draft);
    if (collected.status === "error") {
      setFieldErrors(collected.fieldErrors);
      return;
    }
    submitting.current = true;
    setPending(true);
    setFieldErrors([]);
    try {
      const trimmed = runLabel.trim();
      await onSubmit({ ...(trimmed ? { runLabel: trimmed } : {}), metadata: collected.metadata });
      // Success unmounts this form. Never unlock an already-created run for retry.
    } catch (error) {
      const declaredKeys = new Set(inputs.map((input) => input.key));
      setFieldErrors(workflowRunInputErrorsFromApi(error).filter((field) => declaredKeys.has(field.key)));
      setGeneralError((error instanceof Error ? error.message : String(error)) || "실행 요청에 실패했습니다. 다시 확인해 주세요.");
      submitting.current = false;
      setPending(false);
      // Disabling the focused submit button may move browser focus to the body.
      contentRef.current?.focus();
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
    <DialogContent ref={contentRef} showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      onEscapeKeyDown={(event) => { if (submitting.current) event.preventDefault(); }}
      onInteractOutside={(event) => { if (submitting.current) event.preventDefault(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger?.focus(); }}>
      <DialogHeader>
        <DialogTitle>워크플로 실행</DialogTitle>
        <DialogDescription>{workflow.name} 실행에 사용할 값을 확인해 주세요.</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => { void submit(event); }} noValidate className="space-y-5" aria-busy={pending}>
        <div className="space-y-2">
          <Label htmlFor={labelId}>실행명 (선택)</Label>
          <Input id={labelId} value={runLabel} disabled={pending} onChange={(event) => setRunLabel(event.target.value)} />
        </div>
        {inputs.map((input) => <WorkflowRunInputField key={input.key} input={input}
          value={Object.hasOwn(draft, input.key) ? draft[input.key] : undefined} disabled={pending}
          error={fieldErrors.find((field) => field.key === input.key)?.message}
          onChange={(value) => setDraft((previous) => {
            const next = { ...previous, [input.key]: value };
            Object.setPrototypeOf(next, null);
            return next;
          })} />)}
        {generalError ? <p role="alert" className="text-sm text-destructive">{generalError}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={cancel}>취소</Button>
          <Button type="submit" disabled={pending}>실행</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
