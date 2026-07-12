import { parseObject } from "../adapters/utils.js";

export function shellTokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function stripShellCommentLines(command: string): string {
  return command
    .split(/\r?\n/)
    .map((line) => {
      const shellScriptComment = line.match(/^(\s*(?:\/bin\/)?(?:ba)?sh\s+-[a-z]*c\s+['"]?)\s*#/);
      if (shellScriptComment) return shellScriptComment[1] ?? "";
      if (line.trimStart().startsWith("#")) return "";
      return line;
    })
    .join("\n")
    .trim();
}

export function cleanShellToken(token: string): string {
  return token.replace(/^['"`]+|['"`,:;!?]+$/g, "");
}

export function parseJsonLineObject(line: string): Record<string, unknown> | null {
  try {
    return parseObject(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
