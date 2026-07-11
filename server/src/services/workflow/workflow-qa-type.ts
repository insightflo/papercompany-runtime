export type WorkflowQaInputScope =
  | "mission_plan"
  | "dependency_work_products"
  | "delivery_readback";

export type WorkflowQaContract = {
  readonly type: string;
  readonly inputScope: WorkflowQaInputScope;
  readonly builtIn: boolean;
};

const BUILTIN_QA_CONTRACTS: Readonly<Record<string, WorkflowQaContract>> = {
  plan: {
    type: "plan",
    inputScope: "mission_plan",
    builtIn: true,
  },
  action: {
    type: "action",
    inputScope: "dependency_work_products",
    builtIn: true,
  },
  delivery: {
    type: "delivery",
    inputScope: "delivery_readback",
    builtIn: true,
  },
};

const QA_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;

export function normalizeWorkflowQaType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return QA_TYPE_PATTERN.test(normalized) ? normalized : null;
}

export function resolveWorkflowQaContract(value: unknown): WorkflowQaContract | null {
  const type = normalizeWorkflowQaType(value);
  if (!type) return null;
  return BUILTIN_QA_CONTRACTS[type] ?? {
    type,
    inputScope: "dependency_work_products",
    builtIn: false,
  };
}
