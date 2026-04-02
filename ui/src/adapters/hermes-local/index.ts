import type { UIAdapterModule } from "../types";
import type { CreateConfigValues, TranscriptEntry } from "../types";
import { HermesLocalConfigFields } from "./config-fields";

function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

function buildHermesConfig(values: CreateConfigValues): Record<string, unknown> {
  return {
    instructionsFilePath: values.instructionsFilePath ?? undefined,
  };
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
