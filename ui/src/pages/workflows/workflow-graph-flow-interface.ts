// Workflow flow-interface inputs: normalization, defaults and request-fill preview.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import { readTrimmedString, readPlainObject, readArrayLike } from "./workflow-graph-value-readers.js";
import type { WorkflowGraphRequestFillPreview } from "./workflow-graph-types-test.js";
import type { WorkflowGraphFlowEnvVariable, WorkflowGraphFlowInput, WorkflowGraphInterfaceInput, WorkflowGraphInterfaceSummary } from "./workflow-graph-types-interface.js";
import { readBooleanSetting } from "./workflow-graph-step-metadata.js";

export function summarizeWorkflowGraphInterface(input: WorkflowGraphInterfaceInput): WorkflowGraphInterfaceSummary {
  const legacyMetadata = readPlainObject(input.legacyMetadata);
  const inputs = normalizeFlowInputs(
    input.graphFlowInputs
      ?? input.flowInputs
      ?? legacyMetadata.graphFlowInputs
      ?? legacyMetadata.flowInputs,
  );
  const envVariables = normalizeFlowEnvVariables(
    input.graphFlowEnvVariables
      ?? input.graphFlowEnv
      ?? input.flowEnvVariables
      ?? legacyMetadata.graphFlowEnvVariables
      ?? legacyMetadata.graphFlowEnv
      ?? legacyMetadata.flowEnvVariables,
  );
  const requiredInputCount = inputs.filter((flowInput) => flowInput.required).length;
  const secretEnvCount = envVariables.filter((envVariable) => envVariable.secret).length;
  const badges: string[] = [];
  if (inputs.length > 0) badges.push(`${inputs.length} input${inputs.length === 1 ? "" : "s"}`);
  if (requiredInputCount > 0) badges.push(`${requiredInputCount} required input${requiredInputCount === 1 ? "" : "s"}`);
  if (envVariables.length > 0) badges.push(`${envVariables.length} env var${envVariables.length === 1 ? "" : "s"}`);
  if (secretEnvCount > 0) badges.push(`${secretEnvCount} secret env`);
  if (badges.length === 0) badges.push("No flow interface");
  return { inputs, envVariables, badges };
}

function normalizeFlowInputs(value: unknown): WorkflowGraphFlowInput[] {
  const seen = new Set<string>();
  const inputs: WorkflowGraphFlowInput[] = [];
  for (const entry of readArrayLike(value)) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    inputs.push({
      name,
      type: readTrimmedString(record.type) || "string",
      required: readBooleanSetting(record.required) === true,
      defaultValue: readTrimmedString(record.defaultValue ?? record.default),
      description: readTrimmedString(record.description),
    });
  }
  return inputs;
}

function normalizeFlowEnvVariables(value: unknown): WorkflowGraphFlowEnvVariable[] {
  const seen = new Set<string>();
  const envVariables: WorkflowGraphFlowEnvVariable[] = [];
  for (const entry of readArrayLike(value)) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = readTrimmedString(record.type) || "string";
    envVariables.push({
      name,
      type,
      value: readTrimmedString(record.value),
      secret: readBooleanSetting(record.secret) === true || type.toLowerCase() === "secret",
    });
  }
  return envVariables;
}

function parseFlowInputDefaultValue(flowInput: WorkflowGraphFlowInput): unknown {
  const rawValue = flowInput.defaultValue;
  const normalizedType = flowInput.type.trim().toLowerCase();
  if (!rawValue) {
    if (normalizedType === "number" || normalizedType === "integer") return 0;
    if (normalizedType === "boolean") return false;
    if (normalizedType === "json" || normalizedType === "object" || normalizedType === "array") return {};
    return "";
  }
  if (normalizedType === "number" || normalizedType === "integer") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : rawValue;
  }
  if (normalizedType === "boolean") {
    const lowered = rawValue.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
    return Boolean(rawValue);
  }
  if (normalizedType === "json" || normalizedType === "object" || normalizedType === "array") {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function readPresetArgs(value: unknown): Record<string, unknown> {
  const record = readPlainObject(value);
  const request = readPlainObject(record.request);
  const args = readPlainObject(record.args ?? request.args);
  return { ...args };
}

function extractRequestFillArguments(value: unknown): Record<string, unknown> {
  const record = readPlainObject(value);
  const explicitArgs = readPlainObject(record.args);
  if (Object.keys(explicitArgs).length > 0) return { ...explicitArgs };
  const body = readPlainObject(record.body);
  const query = readPlainObject(record.query);
  if (Object.keys(body).length > 0 || Object.keys(query).length > 0) {
    return { ...body, ...query };
  }
  const request = readPlainObject(record.request);
  const requestArgs = readPlainObject(request.args);
  if (Object.keys(requestArgs).length > 0) return { ...requestArgs };
  return { ...record };
}

export function buildWorkflowGraphRequestFillPreview(
  input: WorkflowGraphInterfaceInput,
  requestText: string,
): WorkflowGraphRequestFillPreview {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  const defaults = Object.fromEntries(
    flowInterface.inputs.map((flowInput) => [flowInput.name, parseFlowInputDefaultValue(flowInput)]),
  );
  const normalizedText = requestText.trim();
  let parsedArguments: Record<string, unknown> = {};
  let error: string | undefined;

  if (normalizedText) {
    try {
      parsedArguments = extractRequestFillArguments(JSON.parse(normalizedText) as unknown);
    } catch (parseError) {
      error = `JSON 파싱 실패: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
    }
  }

  const inputNames = new Set(flowInterface.inputs.map((flowInput) => flowInput.name));
  const matchedInputNames = flowInterface.inputs
    .map((flowInput) => flowInput.name)
    .filter((name) => Object.prototype.hasOwnProperty.call(parsedArguments, name));
  const extraArgumentNames = Object.keys(parsedArguments).filter((name) => !inputNames.has(name)).sort();
  const filledArguments = { ...defaults };
  for (const name of matchedInputNames) {
    filledArguments[name] = parsedArguments[name];
  }
  const missingRequiredInputNames = flowInterface.inputs
    .filter((flowInput) => flowInput.required && !Object.prototype.hasOwnProperty.call(parsedArguments, flowInput.name))
    .map((flowInput) => flowInput.name);
  const badges: string[] = [];
  if (error) badges.push("Invalid request JSON");
  if (!error && matchedInputNames.length > 0) badges.push(`${matchedInputNames.length} matched`);
  if (!error && matchedInputNames.length === 0) badges.push(normalizedText ? "No matching args" : "Paste request JSON");
  if (extraArgumentNames.length > 0) badges.push(`${extraArgumentNames.length} extra ignored`);
  if (missingRequiredInputNames.length > 0) badges.push(`${missingRequiredInputNames.length} missing required`);
  return {
    arguments: filledArguments,
    matchedInputNames,
    extraArgumentNames,
    missingRequiredInputNames,
    badges,
    requestJson: `${JSON.stringify({ args: filledArguments }, null, 2)}\n`,
    error,
  };
}

export {
  normalizeFlowInputs,
  normalizeFlowEnvVariables,
  parseFlowInputDefaultValue,
  readPresetArgs,
};
