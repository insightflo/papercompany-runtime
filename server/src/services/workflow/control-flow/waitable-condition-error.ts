// server/src/services/workflow/control-flow/waitable-condition-error.ts
//
// [purpose] Typed marker for IF-condition failures that can be caused by the
//   closeout race between a producer step completing and its work product being
//   registered (or fully written). Carries the machine-readable source identity
//   so the grace-window decision never parses error message text.
// [safety] Extends the standard "Workflow IF condition failed:" message contract;
//   safeErrorSummary keeps passing it through unchanged. Only the control-node
//   executor consults the type — evaluation semantics are unchanged.

export class WorkProductConditionWaitableError extends Error {
  readonly sourceStepId: string;
  readonly sourceTitle: string;

  constructor(message: string, source: { stepId: string; title: string }) {
    super(message);
    this.name = "WorkProductConditionWaitableError";
    this.sourceStepId = source.stepId;
    this.sourceTitle = source.title;
  }
}
