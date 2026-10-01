export function summarizeMarkdownHandoff(markdown: string | null) {
  const trimmed = markdown?.trim();
  if (!trimmed) return null;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const summary = lines.join(" ");
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}
