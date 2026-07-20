import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KST_OFFSET = "+09:00";

export function resolvePublicationDate(value, now = new Date()) {
  const date = typeof value === "string" && value.trim() ? value.trim() : seoulDate(now);
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Publication date must be YYYY-MM-DD: ${date}`);
  const normalized = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString().slice(0, 10);
  if (normalized !== date) throw new Error(`Publication date must be a valid YYYY-MM-DD calendar date: ${date}`);
  return date;
}

function seoulDate(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function publishedAtKst(date) {
  return `${resolvePublicationDate(date)}T00:00:00${KST_OFFSET}`;
}

function setAttribute(tag, name, value) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(["'])[^"']*\\1`, "i");
  return pattern.test(tag)
    ? tag.replace(pattern, ` ${name}="${value}"`)
    : tag.replace(/\s*\/?\s*>$/, (ending) => ` ${name}="${value}"${ending.includes("/") ? " />" : ">"}`);
}

function upsertMeta(html, attribute, key, content) {
  let found = false;
  const keyPattern = new RegExp(`\\b${attribute}\\s*=\\s*(["'])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "i");
  const next = html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!keyPattern.test(tag)) return tag;
    found = true;
    return setAttribute(tag, "content", content);
  });
  if (found) return next;
  const tag = `<meta ${attribute}="${key}" content="${content}">`;
  return /<\/head>/i.test(next) ? next.replace(/<\/head>/i, `${tag}\n</head>`) : `${tag}\n${next}`;
}

export function normalizePublicationHtml(html, dateValue) {
  const date = resolvePublicationDate(dateValue);
  const publishedAt = publishedAtKst(date);
  let normalized = upsertMeta(String(html), "name", "date", publishedAt);
  normalized = upsertMeta(normalized, "property", "article:published_time", publishedAt);
  let foundTime = false;
  normalized = normalized.replace(/<time\b[^>]*>[\s\S]*?<\/time>/i, (tag) => {
    foundTime = true;
    const openEnd = tag.indexOf(">");
    const open = setAttribute(tag.slice(0, openEnd + 1), "datetime", publishedAt);
    const inner = tag.slice(openEnd + 1, tag.toLowerCase().lastIndexOf("</time>"));
    const visible = DATE_RE.test(inner.trim()) || /\d{4}-\d{2}-\d{2}/.test(inner)
      ? inner.replace(/\d{4}-\d{2}-\d{2}/, date)
      : `작성일: ${date} (KST)`;
    return `${open}${visible}</time>`;
  });
  if (!foundTime) {
    const time = `<time datetime="${publishedAt}">작성일: ${date} (KST)</time>`;
    normalized = /<body\b[^>]*>/i.test(normalized)
      ? normalized.replace(/<body\b[^>]*>/i, (tag) => `${tag}\n${time}`)
      : `${normalized}\n${time}`;
  }
  return normalized;
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, "i"))?.[2] ?? null;
}

function metaContent(html, keyAttribute, key) {
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(match[0], keyAttribute)?.toLowerCase() === key.toLowerCase()) return attribute(match[0], "content");
  }
  return null;
}

export function extractPublicationHtmlEvidence(html) {
  const source = String(html);
  const titleTag = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
  const time = source.match(/<time\b[^>]*>[\s\S]*?<\/time>/i)?.[0] ?? "";
  const timeDatetime = time ? attribute(time.slice(0, time.indexOf(">") + 1), "datetime") : null;
  const visible = time.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const publishedTimeMeta = metaContent(source, "property", "article:published_time");
  const parsed = (timeDatetime ?? publishedTimeMeta ?? "").match(/^(\d{4}-\d{2}-\d{2})T00:00:00([+-]\d{2}:\d{2})$/);
  return {
    title: titleTag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    writtenDate: visible.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    timeDatetime,
    dateMeta: metaContent(source, "name", "date"),
    publishedTimeMeta,
    seoulDate: parsed?.[1] ?? null,
    utcOffset: parsed?.[2] ?? null,
  };
}

export function publicationEvidenceMatches(evidence, expectedDate, expectedTitle) {
  const date = resolvePublicationDate(expectedDate);
  const publishedAt = publishedAtKst(date);
  return evidence.writtenDate === date && evidence.timeDatetime === publishedAt
    && evidence.dateMeta === publishedAt && evidence.publishedTimeMeta === publishedAt
    && evidence.seoulDate === date && evidence.utcOffset === KST_OFFSET
    && (!expectedTitle || evidence.title === expectedTitle);
}

function absoluteHttpUrl(value, label) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must be an absolute HTTP URL`);
  return url.toString();
}

export function resolveWorkProductPath(value, root, label, kind = "file") {
  const requested = resolve(String(value || ""));
  if (lstatSync(requested).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const path = realpathSync(requested);
  const base = realpathSync(resolve(root));
  const rel = relative(base, path);
  if (!rel || rel === "." || rel.startsWith("..") || resolve(base, rel) !== path) {
    throw new Error(`${label} must be inside the configured work-product root`);
  }
  const info = statSync(path);
  if (kind === "file" && !info.isFile()) throw new Error(`${label} must be a regular file`);
  if (kind === "directory" && !info.isDirectory()) throw new Error(`${label} must be a directory`);
  return path;
}

function exactPublishedUrl(value, origin, section, id, label) {
  const actual = absoluteHttpUrl(value, label);
  const expected = new URL(`${String(origin).replace(/\/+$/, "")}/${section}/${id}/index.html`).toString();
  if (actual !== expected) throw new Error(`${label} does not match the configured publication destination`);
  return actual;
}

export function resolveVerificationExpectation(input) {
  if (typeof input.expectedDate === "string" && input.expectedDate.trim() && !input.publishResultPath) {
    throw new Error("expectedDate requires publishResultPath so verification uses the exact publish output");
  }
  const publishResult = input.publishResultPath
    ? JSON.parse(readFileSync(resolveWorkProductPath(
      input.publishResultPath,
      input.workProductRoot,
      "publishResultPath",
    ), "utf8"))
    : null;
  if (publishResult && (publishResult.section !== input.section || publishResult.id !== input.id)) {
    throw new Error("publishResultPath section/id does not match the verify request");
  }
  const dateContractRequired = Boolean(
    (typeof input.expectedDate === "string" && input.expectedDate.trim())
    || input.publishResultPath
    || input.entry?.date,
  );
  const expectedDate = dateContractRequired
    ? resolvePublicationDate(input.expectedDate ?? publishResult?.date ?? input.entry?.date)
    : null;
  return {
    publishResult,
    dateContractRequired,
    expectedDate,
    expectedTitle: publishResult?.title ?? input.entry?.title ?? "",
    beforeCounts: publishResult?.beforeCounts ?? null,
    publicUrl: publishResult
      ? exactPublishedUrl(publishResult.publicUrl, input.pagesOrigin, input.section, input.id, "publish result publicUrl")
      : `${input.pagesOrigin}/${input.section}/${input.id}/index.html`,
    r2Url: publishResult
      ? exactPublishedUrl(publishResult.r2Url, input.r2Public, input.section, input.id, "publish result r2Url")
      : `${input.r2Public}/${input.section}/${input.id}/index.html`,
  };
}
