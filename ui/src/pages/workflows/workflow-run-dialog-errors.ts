import {
  workflowRunInputErrorDetailsSchema,
  type WorkflowRunInputFieldError,
} from "@paperclipai/shared/workflow-run-input-values";
import { ApiError } from "../../api/client.js";

export function workflowRunInputErrorsFromApi(error: unknown): WorkflowRunInputFieldError[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.body;
  if (!body || typeof body !== "object" || !("details" in body)) return [];
  const result = workflowRunInputErrorDetailsSchema.safeParse(body.details);
  return result.success ? result.data.fieldErrors : [];
}
