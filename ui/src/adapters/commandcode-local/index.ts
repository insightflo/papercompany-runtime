import type { UIAdapterModule } from "../types";
import { parseCommandCodeStdoutLine } from "@paperclipai/adapter-commandcode-local/ui";
import { CommandCodeLocalConfigFields } from "./config-fields";
import { buildCommandCodeLocalConfig } from "@paperclipai/adapter-commandcode-local/ui";

export const commandCodeLocalUIAdapter: UIAdapterModule = {
  type: "commandcode_local",
  label: "Command Code (local)",
  parseStdoutLine: parseCommandCodeStdoutLine,
  ConfigFields: CommandCodeLocalConfigFields,
  buildAdapterConfig: buildCommandCodeLocalConfig,
};
