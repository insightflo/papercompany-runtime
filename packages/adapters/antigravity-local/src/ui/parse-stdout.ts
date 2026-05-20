import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  return [{ kind: "stdout", ts, text: line }];
}
