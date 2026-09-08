import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.js";
import { workflowRunInputErrorsFromApi } from "./workflow-run-dialog-errors.js";

const fieldErrors = [{ key: "section", code: "invalid_option", message: "선택지를 확인해 주세요." }];
const details = { version: 1, code: "invalid_workflow_run_inputs", fieldErrors };

describe("workflowRunInputErrorsFromApi", () => {
  it("returns versioned field errors from a real ApiError body", () => {
    expect(workflowRunInputErrorsFromApi(new ApiError("Invalid workflow run input values", 400, { details })))
      .toEqual(fieldErrors);
  });

  it("uses structured data rather than the human-readable error message", () => {
    expect(workflowRunInputErrorsFromApi(new ApiError("Unrelated display text", 400, { details })))
      .toEqual(fieldErrors);
    expect(workflowRunInputErrorsFromApi(new Error(JSON.stringify({ details })))).toEqual([]);
    expect(workflowRunInputErrorsFromApi({ body: { details }, status: 400 })).toEqual([]);
  });

  it.each([
    undefined, null, "Invalid workflow run input values", [], {},
    { details: null },
    { details: { ...details, version: 2 } },
    { details: { ...details, code: "unknown" } },
    { details: { ...details, fieldErrors: {} } },
    { details: { ...details, fieldErrors: [null] } },
    { details: { ...details, fieldErrors: [{ key: "section", code: "unknown", message: "No" }] } },
    { details: { ...details, fieldErrors: [{ key: "section", code: "required" }] } },
    { details: { ...details, fieldErrors: [{ key: "", code: "required", message: "No" }] } },
    { details: { ...details, fieldErrors: [...fieldErrors, { key: "section", code: "required", message: 1 }] } },
    { details: { ...details, unexpected: true } },
  ])("rejects malformed or unrecognized error body %#", (body) => {
    expect(workflowRunInputErrorsFromApi(new ApiError("Failure", 400, body))).toEqual([]);
  });

  it.each([undefined, null, "Failure", 400])("ignores non-ApiError values %#", (error) => {
    expect(workflowRunInputErrorsFromApi(error)).toEqual([]);
  });
});
