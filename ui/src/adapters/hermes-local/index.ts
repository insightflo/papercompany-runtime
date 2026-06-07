import type { UIAdapterModule } from "../types";
import type { CreateConfigValues, TranscriptEntry } from "../types";
import {
  buildHermesConfig as buildBaseHermesConfig,
  parseHermesStdoutLine as parseBaseHermesStdoutLine,
} from "hermes-paperclip-adapter/ui";
import { HermesLocalConfigFields } from "./config-fields";

const HERMES_TOOL_VERB_TO_NAME: Record<string, string> = {
  $: "shell",
  exec: "shell",
  terminal: "shell",
  search: "search",
  fetch: "fetch",
  crawl: "crawl",
  navigate: "browser",
  snapshot: "browser",
  click: "browser",
  type: "browser",
  scroll: "browser",
  back: "browser",
  press: "browser",
  close: "browser",
  images: "browser",
  vision: "browser",
  read: "read",
  write: "write",
  patch: "patch",
  grep: "search",
  find: "search",
  plan: "plan",
  recall: "recall",
  proc: "process",
  delegate: "delegate",
  todo: "todo",
  memory: "memory",
  clarify: "clarify",
  session_search: "recall",
  code: "execute",
  execute: "execute",
  web_search: "search",
  web_extract: "fetch",
  browser_navigate: "browser",
  browser_click: "browser",
  browser_type: "browser",
  browser_snapshot: "browser",
  browser_vision: "browser",
  browser_scroll: "browser",
  browser_press: "browser",
  browser_back: "browser",
  browser_close: "browser",
  browser_get_images: "browser",
  read_file: "read",
  write_file: "write_file",
  search_files: "search",
  patch_file: "patch",
  execute_code: "execute",
};

function normalizeHermesToolDetail(detail: string) {
  const originalDetail = detail.trim();
  const match = originalDetail.match(/^(\$|[a-z_][\w-]*)\s+(.*)$/i);
  if (!match) return null;
  const toolName = HERMES_TOOL_VERB_TO_NAME[match[1].toLowerCase()];
  if (!toolName) return null;
  return { toolName, detail: match[2].trim(), originalDetail };
}

function normalizeHermesToolEntries(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  const normalizedById = new Map<
    string,
    { toolName: string; detail: string; originalDetail: string }
  >();

  return entries.map((entry) => {
    if (entry.kind === "tool_call") {
      const input = entry.input;
      const detail =
        input &&
        typeof input === "object" &&
        "detail" in input &&
        typeof input.detail === "string"
          ? input.detail
          : undefined;
      const normalized = detail ? normalizeHermesToolDetail(detail) : null;
      if (!normalized) return entry;
      if (entry.toolUseId) normalizedById.set(entry.toolUseId, normalized);
      const nextInput =
        input && typeof input === "object"
          ? { ...input, detail: normalized.detail }
          : { detail: normalized.detail };
      return {
        ...entry,
        name: normalized.toolName,
        input: nextInput,
      };
    }

    if (entry.kind === "tool_result") {
      const normalized = normalizedById.get(entry.toolUseId);
      if (!normalized) return entry;
      const content = entry.content.trim().startsWith(normalized.originalDetail)
        ? entry.content.replace(normalized.originalDetail, normalized.detail)
        : entry.content;
      return { ...entry, toolName: normalized.toolName, content };
    }

    return entry;
  });
}

function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return normalizeHermesToolEntries(
    parseBaseHermesStdoutLine(line, ts) as unknown as TranscriptEntry[],
  );
}

function buildHermesConfig(
  values: CreateConfigValues,
): Record<string, unknown> {
  return {
    ...buildBaseHermesConfig(
      values as unknown as Parameters<typeof buildBaseHermesConfig>[0],
    ),
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
