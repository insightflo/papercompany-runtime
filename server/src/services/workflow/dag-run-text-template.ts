import { workflowRuns } from "@paperclipai/db";
import { stringifyWorkflowRunMetadataValue } from "./tool-step-args.js";

const RUN_METADATA_TEXT_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;

export function renderWorkflowRunTextTemplate(
  value: string,
  run: typeof workflowRuns.$inferSelect,
): string {
  const runDate = run.runDate ?? "";
  const runMetadata = run.metadata ?? {};
  return value
    .replaceAll("{$runDate}", runDate)
    .replaceAll("{$date}", runDate)
    .replace(RUN_METADATA_TEXT_TOKEN, (token, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(runMetadata, key)) return token;
      const rendered = stringifyWorkflowRunMetadataValue(runMetadata[key]);
      return rendered === null ? token : rendered;
    });
}
