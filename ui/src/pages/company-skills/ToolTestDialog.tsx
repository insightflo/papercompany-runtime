import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ToolDefinition, ToolTestOutcome } from "@paperclipai/shared";
import { AlertCircle, CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import { toolDefinitionsApi } from "../../api/tools";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../../lib/utils";
import { formatTestResult, parseTestInput } from "./toolTestModel";

type ToolTestDialogProps = {
  companyId: string;
  tool: ToolDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type RunState = { status: "success" | "failure" | "error" };

const STATUS_META: Record<RunState["status"], { label: string; icon: typeof CheckCircle2; className: string }> = {
  success: { label: "Success", icon: CheckCircle2, className: "text-green-600 dark:text-green-300" },
  failure: { label: "Failure", icon: XCircle, className: "text-amber-600 dark:text-amber-300" },
  error: { label: "Error", icon: AlertCircle, className: "text-destructive" },
};

/**
 * In-dialog tool test runner. Prefilled with `{}`, lets the operator edit the
 * input JSON, blocks invalid JSON client-side, and shows a clear
 * pending/success/failure result plus formatted response without leaving the
 * page. Only saved tools can be tested.
 */
export function ToolTestDialog({ companyId, tool, open, onOpenChange }: ToolTestDialogProps) {
  const [inputJson, setInputJson] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ToolTestOutcome | null>(null);

  useEffect(() => {
    if (open) {
      setInputJson("{}");
      setParseError(null);
      setOutcome(null);
    }
  }, [open, tool.id]);

  const runTest = useMutation({
    mutationFn: (input: Record<string, unknown>) => toolDefinitionsApi.test(companyId, tool.id, input),
    onSuccess: (result) => setOutcome(result),
    onError: (error) => {
      setOutcome({
        ok: false,
        status: "error",
        httpStatus: 0,
        error: error instanceof Error ? error.message : "Test request failed.",
      });
    },
  });

  function handleRun() {
    const parsed = parseTestInput(inputJson);
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    runTest.mutate(parsed.value);
  }

  const running = runTest.isPending;
  const inputValid = parseTestInput(inputJson).ok;
  const status = outcome?.status;
  const StatusIcon = status ? STATUS_META[status].icon : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test tool — {tool.name}</DialogTitle>
          <DialogDescription>
            Run this saved tool with a JSON input. The test uses the same execution path as workflows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="tool-test-input">
            Input JSON
          </label>
          <Textarea
            id="tool-test-input"
            value={inputJson}
            onChange={(event) => {
              setInputJson(event.target.value);
              setParseError(null);
            }}
            className="min-h-32 font-mono text-sm"
            spellCheck={false}
            disabled={running}
          />
          {parseError ? (
            <p className="text-sm text-destructive">Invalid JSON: {parseError}</p>
          ) : null}
        </div>

        {outcome ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-sm">
              {StatusIcon ? (
                <StatusIcon className={cn("h-4 w-4", STATUS_META[outcome.status].className)} />
              ) : null}
              <span className={cn("font-medium", STATUS_META[outcome.status].className)}>
                {STATUS_META[outcome.status].label}
              </span>
              <span className="text-muted-foreground">HTTP {outcome.httpStatus}</span>
            </div>
            {outcome.error ? (
              <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 text-xs text-destructive whitespace-pre-wrap break-words">
                {outcome.error}
              </pre>
            ) : null}
            {outcome.result !== undefined ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Response</p>
                <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
                  {formatTestResult(outcome.result)}
                </pre>
              </div>
            ) : null}
            {outcome.stderr ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">stderr</p>
                <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
                  {outcome.stderr}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
            Close
          </Button>
          <Button onClick={handleRun} disabled={running || !inputValid}>
            {running ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Run test
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
