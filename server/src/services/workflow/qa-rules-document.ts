import { JSDOM } from "jsdom";
import { containsInternalPath } from "./qa-internal-paths.js";

/** Inspect supplied bytes only. jsdom's default disables script execution and resource fetching. */
export function inspectQaDocument(json: unknown, html?: string, internalPathRoots: readonly string[] = []) {
  const strings: string[] = [], keys: string[] = [];
  let nodes = 0;
  const collect = (value: unknown, depth = 0) => {
    if (++nodes > 100000 || depth > 100) throw new Error("qa_document_limit");
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(v => collect(v, depth + 1));
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) { keys.push(key); collect(entry, depth + 1); }
    }
  };
  collect(json);
  if (html !== undefined) strings.push(html);
  const text = strings.join("\n");
  if (text.length > 8 * 1024 * 1024) throw new Error("qa_document_limit");
  const links = new Set<string>();
  const decoded: string[] = [];
  let externalScript = false, externalIframe = false;
  for (const value of strings) {
    for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) links.add(match[0]);
    if (!value.includes("<")) continue;
    const dom = new JSDOM(value);
    try {
      const doc = dom.window.document;
      decoded.push(doc.documentElement.textContent ?? "");
      // Without executing/parsing JavaScript, inline code cannot prove that it never
      // imports or injects external scripts. Only inert JSON data blocks are accepted.
      for (const script of doc.querySelectorAll("script")) {
        const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
        externalScript ||= script.hasAttribute("src") || script.hasAttribute("href") || script.hasAttribute("xlink:href")
          || !["application/json", "application/ld+json"].includes(type);
      }
      externalIframe ||= doc.querySelector("iframe") !== null;
      for (const element of doc.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          decoded.push(attribute.value);
          externalScript ||= /^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value.replace(/[\u0000-\u0020]/g, ""));
        }
      }
      for (const link of doc.querySelectorAll("a[href],area[href]")) links.add(link.getAttribute("href") ?? "");
    } finally { dom.window.close(); }
  }
  const sensitiveKey = /^(?:api[_-]?key|access[_-]?token|password|private[_-]?key|secret|authorization)$/i;
  const inspectedText = [text, ...decoded].join("\n");
  const sensitive = keys.some(key => sensitiveKey.test(key))
    || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:api[_-]?key|password|secret|access[_-]?token)["']?\s*[:=]\s*["']?[^\s<"']+/i.test(inspectedText)
    || containsInternalPath(inspectedText, internalPathRoots);
  const isHttps = (link: string) => {
    try { const url = new URL(link); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  };
  // Relative links/fragments refer to this artifact. Protocol-relative and active schemes do not.
  const secureLinks = [...links].every(link => {
    const normalized = link.trim().replace(/[\u0000-\u0020]/g, "");
    if (!normalized || normalized.startsWith("#")) return true;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !normalized.startsWith("//") && !normalized.startsWith("\\")) return true;
    return isHttps(normalized);
  });
  return { text, externalScript, externalIframe, sensitive, secureLinks,
    sourceLinks: [...links].filter(isHttps) };
}
