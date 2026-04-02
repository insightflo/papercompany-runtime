import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  worktreeApi,
  type WorktreeRule,
  type RuleSeverity,
  type RuleAction,
  type CreateRuleInput,
  type UpdateRuleInput,
  type Predicate,
} from "../api/worktree";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ShieldCheck,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  ToggleLeft,
  ToggleRight,
  Code2,
  FormInput,
} from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITIES: RuleSeverity[] = ["MUST", "SHOULD", "MAY"];

const SEVERITY_COLORS: Record<RuleSeverity, string> = {
  MUST: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  SHOULD: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  MAY: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
};

const RULE_ACTIONS: RuleAction[] = [
  "tool_call",
  "file_read",
  "file_write",
  "file_delete",
  "network_request",
  "command_execution",
  "state_query",
];

// Predicate operators available in the form builder
const PREDICATE_OPERATORS = ["$eq", "$ne", "$contains", "$startsWith", "$endsWith", "$in", "$notIn", "$matches", "$gt", "$lt"] as const;
type PredicateOperator = typeof PREDICATE_OPERATORS[number];

// ---------------------------------------------------------------------------
// Types for the form builder
// ---------------------------------------------------------------------------

interface PredicateClause {
  field: string;
  operator: PredicateOperator;
  value: string;
}

function clausesToPredicate(clauses: PredicateClause[]): Predicate {
  const result: Predicate = {};
  for (const clause of clauses) {
    if (!clause.field.trim()) continue;
    const isArrayOp = clause.operator === "$in" || clause.operator === "$notIn";
    const val = isArrayOp
      ? clause.value.split(",").map((v) => v.trim()).filter(Boolean)
      : clause.value;
    result[clause.field.trim()] = { [clause.operator]: val };
  }
  return result;
}

function predicateToClauses(pred: Predicate): PredicateClause[] {
  const clauses: PredicateClause[] = [];
  for (const [field, val] of Object.entries(pred)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const ops = Object.keys(val as object) as PredicateOperator[];
      for (const op of ops) {
        if (PREDICATE_OPERATORS.includes(op)) {
          const raw = (val as Record<string, unknown>)[op];
          clauses.push({
            field,
            operator: op,
            value: Array.isArray(raw) ? raw.join(", ") : String(raw ?? ""),
          });
        }
      }
    }
  }
  return clauses.length > 0 ? clauses : [{ field: "", operator: "$eq", value: "" }];
}

// ---------------------------------------------------------------------------
// SeverityBadge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: RuleSeverity }) {
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded font-mono font-medium", SEVERITY_COLORS[severity])}>
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PredicateFormBuilder
// ---------------------------------------------------------------------------

interface PredicateFormBuilderProps {
  clauses: PredicateClause[];
  onChange: (clauses: PredicateClause[]) => void;
}

function PredicateFormBuilder({ clauses, onChange }: PredicateFormBuilderProps) {
  function update(i: number, partial: Partial<PredicateClause>) {
    const next = clauses.map((c, idx) => (idx === i ? { ...c, ...partial } : c));
    onChange(next);
  }

  function addClause() {
    onChange([...clauses, { field: "", operator: "$eq", value: "" }]);
  }

  function removeClause(i: number) {
    const next = clauses.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : [{ field: "", operator: "$eq", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {clauses.map((clause, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-7 text-xs w-32 shrink-0"
            placeholder="field"
            value={clause.field}
            onChange={(e) => update(i, { field: e.target.value })}
          />
          <Select value={clause.operator} onValueChange={(v) => update(i, { operator: v as PredicateOperator })}>
            <SelectTrigger className="h-7 text-xs w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREDICATE_OPERATORS.map((op) => (
                <SelectItem key={op} value={op}>{op}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-7 text-xs flex-1"
            placeholder={
              clause.operator === "$in" || clause.operator === "$notIn"
                ? "val1, val2, ..."
                : "value"
            }
            value={clause.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => removeClause(i)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 text-xs text-muted-foreground"
        onClick={addClause}
      >
        <Plus className="h-3 w-3 mr-1" />
        Add condition
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RuleForm — shared between create and edit
// ---------------------------------------------------------------------------

interface RuleFormValues {
  name: string;
  severity: RuleSeverity;
  action: string;
  message: string;
  enabled: boolean;
  // builder mode
  clauses: PredicateClause[];
  // raw JSON mode
  predicateJson: string;
  useRawJson: boolean;
}

function defaultFormValues(rule?: WorktreeRule): RuleFormValues {
  if (rule) {
    return {
      name: rule.name,
      severity: rule.severity as RuleSeverity,
      action: rule.action,
      message: rule.message,
      enabled: rule.enabled,
      clauses: predicateToClauses(rule.predicate),
      predicateJson: JSON.stringify(rule.predicate, null, 2),
      useRawJson: false,
    };
  }
  return {
    name: "",
    severity: "SHOULD",
    action: "tool_call",
    message: "",
    enabled: true,
    clauses: [{ field: "", operator: "$eq", value: "" }],
    predicateJson: "{}",
    useRawJson: false,
  };
}

interface RuleFormProps {
  initial?: WorktreeRule;
  onSubmit: (input: CreateRuleInput) => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}

function RuleForm({ initial, onSubmit, onCancel, isPending, error }: RuleFormProps) {
  const [values, setValues] = useState<RuleFormValues>(() => defaultFormValues(initial));
  const [jsonError, setJsonError] = useState<string | null>(null);

  function set<K extends keyof RuleFormValues>(key: K, val: RuleFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  function toggleMode() {
    if (!values.useRawJson) {
      // switching to raw — serialize current clauses
      const pred = clausesToPredicate(values.clauses);
      set("predicateJson", JSON.stringify(pred, null, 2));
    } else {
      // switching to builder — try to parse current JSON
      try {
        const pred = JSON.parse(values.predicateJson) as Predicate;
        set("clauses", predicateToClauses(pred));
        setJsonError(null);
      } catch {
        setJsonError("Invalid JSON — fix before switching to form mode");
        return;
      }
    }
    set("useRawJson", !values.useRawJson);
  }

  function buildPredicate(): Predicate | null {
    if (values.useRawJson) {
      try {
        return JSON.parse(values.predicateJson) as Predicate;
      } catch {
        setJsonError("Invalid JSON predicate");
        return null;
      }
    }
    return clausesToPredicate(values.clauses);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setJsonError(null);
    const predicate = buildPredicate();
    if (predicate === null) return;
    if (!values.name.trim()) return;
    if (!values.action) return;

    onSubmit({
      name: values.name.trim(),
      severity: values.severity,
      action: values.action,
      predicate,
      message: values.message.trim(),
      enabled: values.enabled,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 border border-border rounded-md p-4 bg-card">
      <p className="text-sm font-medium">{initial ? "Edit Rule" : "New Rule"}</p>

      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Name</label>
        <Input
          className="h-8 text-sm"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Block file writes outside workspace"
          required
        />
      </div>

      {/* Severity + Action row */}
      <div className="flex gap-3">
        <div className="space-y-1.5 w-32 shrink-0">
          <label className="text-xs text-muted-foreground">Severity</label>
          <Select value={values.severity} onValueChange={(v) => set("severity", v as RuleSeverity)}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5 flex-1">
          <label className="text-xs text-muted-foreground">Action</label>
          <Select value={values.action} onValueChange={(v) => set("action", v)}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
              <SelectItem value="__custom__">custom…</SelectItem>
            </SelectContent>
          </Select>
          {values.action === "__custom__" && (
            <Input
              className="h-8 text-sm mt-1"
              placeholder="custom action name"
              onChange={(e) => set("action", e.target.value)}
            />
          )}
        </div>
      </div>

      {/* Message */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Violation message</label>
        <Input
          className="h-8 text-sm"
          value={values.message}
          onChange={(e) => set("message", e.target.value)}
          placeholder="e.g. File writes outside workspace are not allowed"
        />
      </div>

      {/* Predicate section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Predicate</label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1.5"
            onClick={toggleMode}
          >
            {values.useRawJson
              ? <><FormInput className="h-3 w-3" /> Form</>
              : <><Code2 className="h-3 w-3" /> JSON</>}
          </Button>
        </div>

        {values.useRawJson ? (
          <textarea
            className={cn(
              "w-full h-32 text-xs font-mono rounded-md border border-input bg-background px-3 py-2 resize-y focus:outline-none focus:ring-1 focus:ring-ring",
              jsonError && "border-destructive",
            )}
            value={values.predicateJson}
            onChange={(e) => { set("predicateJson", e.target.value); setJsonError(null); }}
            spellCheck={false}
          />
        ) : (
          <PredicateFormBuilder
            clauses={values.clauses}
            onChange={(c) => set("clauses", c)}
          />
        )}

        {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
        <p className="text-xs text-muted-foreground">
          Operators: $eq $ne $contains $startsWith $endsWith $in $notIn $matches $gt $lt
        </p>
      </div>

      {/* Enabled */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(values.enabled ? "text-green-600" : "text-muted-foreground")}
          onClick={() => set("enabled", !values.enabled)}
          title={values.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        >
          {values.enabled
            ? <ToggleRight className="h-4 w-4" />
            : <ToggleLeft className="h-4 w-4" />}
        </Button>
        <span className="text-xs text-muted-foreground">{values.enabled ? "Enabled" : "Disabled"}</span>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={isPending}>
          {isPending ? "Saving..." : initial ? "Save" : "Create"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// RuleRow
// ---------------------------------------------------------------------------

interface RuleRowProps {
  rule: WorktreeRule;
  companyId: string;
}

function RuleRow({ rule, companyId }: RuleRowProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.worktree.rules(companyId) });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => worktreeApi.updateRule(rule.id, { enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: () => worktreeApi.deleteRule(rule.id),
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateRuleInput) => worktreeApi.updateRule(rule.id, data),
    onSuccess: () => { invalidate(); setEditing(false); setMutError(null); },
    onError: (err) => setMutError(err instanceof Error ? err.message : "Failed to update"),
  });

  if (editing) {
    return (
      <div className="px-4 py-3 border-b border-border last:border-b-0">
        <RuleForm
          initial={rule}
          onSubmit={(input) => updateMutation.mutate(input)}
          onCancel={() => { setEditing(false); setMutError(null); }}
          isPending={updateMutation.isPending}
          error={mutError}
        />
      </div>
    );
  }

  return (
    <div className={cn("border-b border-border last:border-b-0", !rule.enabled && "opacity-60")}>
      {/* Row header */}
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <button
          className="p-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />

        <span className="flex-1 truncate font-medium">{rule.name}</span>

        <SeverityBadge severity={rule.severity as RuleSeverity} />

        <span className="text-xs text-muted-foreground shrink-0 hidden sm:block font-mono">
          {rule.action}
        </span>

        {/* Toggle enabled */}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("shrink-0", rule.enabled ? "text-green-600" : "text-muted-foreground")}
          onClick={() => toggleMutation.mutate(!rule.enabled)}
          disabled={toggleMutation.isPending}
          title={rule.enabled ? "Disable" : "Enable"}
        >
          {rule.enabled
            ? <ToggleRight className="h-4 w-4" />
            : <ToggleLeft className="h-4 w-4" />}
        </Button>

        {/* Edit */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs shrink-0"
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-10 pb-3 space-y-2 text-xs text-muted-foreground">
          {rule.message && (
            <p><span className="font-medium text-foreground">Message:</span> {rule.message}</p>
          )}
          <div>
            <p className="font-medium text-foreground mb-1">Predicate:</p>
            <pre className="bg-muted/50 rounded p-2 overflow-x-auto text-xs font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(rule.predicate, null, 2)}
            </pre>
          </div>
          <p>
            <span className="font-medium text-foreground">Version:</span> {rule.version}
            {" · "}
            <span className="font-medium text-foreground">Created by:</span> {rule.createdBy}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorktreeRules page
// ---------------------------------------------------------------------------

export function WorktreeRules() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [severityFilter, setSeverityFilter] = useState<RuleSeverity | "all">("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Worktree Rules" }]);
  }, [setBreadcrumbs]);

  const { data: rules, isLoading, error } = useQuery({
    queryKey: queryKeys.worktree.rules(selectedCompanyId!),
    queryFn: () =>
      worktreeApi.listRules(selectedCompanyId!, {
        severity: severityFilter !== "all" ? severityFilter : undefined,
      }),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateRuleInput) =>
      worktreeApi.createRule(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.worktree.rules(selectedCompanyId!) });
      setShowCreateForm(false);
      setCreateError(null);
    },
    onError: (err) => setCreateError(err instanceof Error ? err.message : "Failed to create rule"),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to view worktree rules." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Client-side filter (the API also supports server-side, but filter tabs reuse cached data)
  const filtered =
    rules && severityFilter !== "all"
      ? rules.filter((r) => r.severity === severityFilter)
      : rules ?? [];

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Severity filter tabs */}
        <div className="flex items-center gap-1 flex-wrap">
          {(["all", ...SEVERITIES] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={severityFilter === s ? "default" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setSeverityFilter(s)}
            >
              {s === "all" ? "All" : s}
              {s !== "all" && rules && (
                <span className="ml-1 text-[10px] opacity-70">
                  {rules.filter((r) => r.severity === s).length}
                </span>
              )}
            </Button>
          ))}
        </div>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => { setShowCreateForm((v) => !v); setCreateError(null); }}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Rule
        </Button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <RuleForm
          onSubmit={(input) => createMutation.mutate(input)}
          onCancel={() => { setShowCreateForm(false); setCreateError(null); }}
          isPending={createMutation.isPending}
          error={createError}
        />
      )}

      <Separator />

      {/* Empty state */}
      {filtered.length === 0 && !showCreateForm && (
        <EmptyState
          icon={ShieldCheck}
          message={
            severityFilter === "all"
              ? "No worktree rules yet."
              : `No ${severityFilter} rules.`
          }
          action={severityFilter === "all" ? "New Rule" : undefined}
          onAction={severityFilter === "all" ? () => setShowCreateForm(true) : undefined}
        />
      )}

      {/* Rule list */}
      {filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((rule) => (
            <RuleRow key={rule.id} rule={rule} companyId={selectedCompanyId} />
          ))}
        </div>
      )}
    </div>
  );
}
