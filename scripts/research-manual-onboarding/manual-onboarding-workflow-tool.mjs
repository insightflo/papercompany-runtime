#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { contentTypeForPath, stageSourceAssets } from "./manual-onboarding-assets.mjs";
import {
  extractPublicationHtmlEvidence,
  normalizePublicationHtml,
  publicationEvidenceMatches,
  publishedAtKst,
  resolvePublicationDate,
  resolveVerificationExpectation,
  resolveWorkProductPath,
} from "./publication-date-contract.mjs";

const SITE_ROOT = resolve(process.env.MANUAL_ONBOARDING_SITE_ROOT || "/srv/manual-onboarding-cloudflare");
const PUBLIC_ROOT = resolve(SITE_ROOT, "public", "onboarding");
const WORK_PRODUCT_ROOT = resolve(process.env.MANUAL_ONBOARDING_WORK_PRODUCT_ROOT || "/srv/papercompany/projects/research-company/produced_work");
const PUBLISHER_ROOT = resolve(process.env.MANUAL_ONBOARDING_PUBLISHER_ROOT || "/srv/papercompany/company-skills/manual-onboarding-publisher");
const PUBLISHER_SCRIPT = join(PUBLISHER_ROOT, "scripts", "manual-onboarding-publisher.mjs");
const PAGES_ORIGIN = String(process.env.MANUAL_ONBOARDING_PAGES_ORIGIN || "https://manual-onboarding.pages.dev/onboarding").replace(/\/+$/, "");
const R2_PUBLIC = String(process.env.MANUAL_ONBOARDING_R2_PUBLIC || "https://pub-1278c99ff85948c08794f254b55c7f90.r2.dev").replace(/\/+$/, "");
const R2_BUCKET = String(process.env.MANUAL_ONBOARDING_R2_BUCKET || "manual-onboarding-detail");
const PAGES_PROJECT = String(process.env.MANUAL_ONBOARDING_PAGES_PROJECT || "manual-onboarding");
const SECTION_CONFIG = {
  "tech-news": { dir: "tech-news", key: "tech_news" },
  tech_news: { dir: "tech-news", key: "tech_news" },
  "tech-scout": { dir: "tech-scout", key: "tech_scout" },
  tech_scout: { dir: "tech-scout", key: "tech_scout" },
  manuals: { dir: "manuals", key: "manuals" },
  concepts: { dir: "concepts", key: "concepts" },
};
const REQUIRED_KEYS = ["tech_news", "tech_scout", "manuals", "concepts"];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) opts[key] = true;
    else { opts[key] = next; i += 1; }
  }
  return { command, opts };
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, details = {}) {
  jsonOut({ ok: false, error: message, ...details });
  process.exit(1);
}

function requireString(opts, key) {
  const value = opts[key];
  if (typeof value !== "string" || !value.trim()) {
    fail(`Missing required option --${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`);
  }
  return value.trim();
}

function normalizeSection(section) {
  const cfg = SECTION_CONFIG[String(section || "").trim()];
  if (!cfg) fail("Unknown section", { section, allowedSections: ["tech-news", "tech-scout", "manuals", "concepts"] });
  return cfg;
}

function assertInsideRoot(path, root, label) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel === "" || resolve(root, rel) !== path) fail(`${label} must be inside the expected root`, { label });
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function countsFromIndex(index) {
  return Object.fromEntries(REQUIRED_KEYS.map((key) => [key, Array.isArray(index?.[key]) ? index[key].length : 0]));
}

function nonEmptySections(counts) {
  return REQUIRED_KEYS.filter((key) => Number(counts[key] || 0) > 0);
}

function decreasedSections(before, after) {
  return REQUIRED_KEYS.filter((key) => Number(after[key] || 0) < Number(before[key] || 0));
}

function assertIndexHealth(beforeCounts, afterCounts) {
  const empty = REQUIRED_KEYS.filter((key) => Number(afterCounts[key] || 0) <= 0);
  const decreased = decreasedSections(beforeCounts, afterCounts);
  if (empty.length || decreased.length) fail("index.json health check failed", { beforeCounts, afterCounts, emptySections: empty, decreasedSections: decreased });
}
function assertSafeDetailId(rawId, cfg) {
  const id = String(rawId || "").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) fail("id may contain only letters, numbers, dot, underscore, and dash", { id });
  if (id === "." || id === ".." || /[\\/]/.test(id)) fail("id must be a safe detail slug, not a path segment", { id });
  const sectionDir = resolve(PUBLIC_ROOT, cfg.dir);
  const destDir = resolve(sectionDir, id);
  const rel = relative(sectionDir, destDir);
  if (rel === "" || rel === "." || rel.startsWith("..") || resolve(sectionDir, rel) !== destDir) {
    fail("id must resolve to a strict child of the section directory", { id, section: cfg.dir });
  }
  return id;
}

function extractCatalogMeta(html) {
  const evidence = extractPublicationHtmlEvidence(html);
  const description = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
  const paragraph = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  return {
    title: evidence.title,
    subtitle: (description?.[1] ?? paragraph.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 180),
  };
}

function runNodeBuildIndex() {
  execFileSync(process.execPath, [PUBLISHER_SCRIPT, "build-index", "--root", PUBLIC_ROOT], {
    cwd: PUBLISHER_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
}

function runWrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: SITE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env,
    timeout: 240000, maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function writeResultFile(filename, payload) {
  const dir = process.env.PAPERCLIP_STEP_OUTPUT_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

function validatedDate(value) {
  try { return resolvePublicationDate(value); }
  catch (error) { fail(error.message); }
}

async function publish(opts) {
  const cfg = normalizeSection(requireString(opts, "section"));
  const id = assertSafeDetailId(requireString(opts, "id"), cfg);
  const sourceHtmlPath = resolve(requireString(opts, "sourceHtmlPath"));
  if (!existsSync(sourceHtmlPath)) fail("sourceHtmlPath does not exist", { sourceHtmlPath });
  try { resolveWorkProductPath(sourceHtmlPath, WORK_PRODUCT_ROOT, "sourceHtmlPath workProduct"); }
  catch (error) { fail(error.message); }

  const sourceHtml = readFileSync(sourceHtmlPath, "utf8");
  const meta = extractCatalogMeta(sourceHtml);
  if (!meta.title) fail("source HTML must contain a title or h1", { sourceHtmlPath });
  const date = validatedDate(opts.date);
  const status = typeof opts.status === "string" && opts.status.trim() ? opts.status.trim() : "published";
  const beforeCounts = countsFromIndex(readJson(join(PUBLIC_ROOT, "index.json"), {}));
  const destDir = resolve(PUBLIC_ROOT, cfg.dir, id);
  assertInsideRoot(destDir, PUBLIC_ROOT, "destination detail directory");
  mkdirSync(destDir, { recursive: true });
  const destHtml = join(destDir, "index.html");
  writeFileSync(destHtml, normalizePublicationHtml(sourceHtml, date), "utf8");

  let assetPaths = [];
  if (typeof opts.sourceAssetDir === "string" && opts.sourceAssetDir.trim()) {
    const sourceAssetDir = resolve(opts.sourceAssetDir.trim());
    if (!existsSync(sourceAssetDir)) fail("sourceAssetDir does not exist", { sourceAssetDir });
    try { resolveWorkProductPath(sourceAssetDir, WORK_PRODUCT_ROOT, "sourceAssetDir workProduct", "directory"); }
    catch (error) { fail(error.message); }
    assetPaths = await stageSourceAssets(sourceAssetDir, destDir);
  }
  const manifestPath = join(destDir, `${cfg.dir}.manifest.json`);
  const manifest = {
    id, title: meta.title, subtitle: meta.subtitle, date, status,
    generated_at: new Date().toISOString(), source_html_path: sourceHtmlPath, asset_paths: assetPaths,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  runNodeBuildIndex();
  const afterCounts = countsFromIndex(readJson(join(PUBLIC_ROOT, "index.json"), {}));
  assertIndexHealth(beforeCounts, afterCounts);
  const r2HtmlKey = `${cfg.dir}/${id}/index.html`;
  const r2ManifestKey = `${cfg.dir}/${id}/${cfg.dir}.manifest.json`;
  const r2Html = runWrangler(["r2", "object", "put", `${R2_BUCKET}/${r2HtmlKey}`, "--file", destHtml, "--content-type", "text/html; charset=utf-8", "--remote"]);
  const r2Manifest = runWrangler(["r2", "object", "put", `${R2_BUCKET}/${r2ManifestKey}`, "--file", manifestPath, "--content-type", "application/json; charset=utf-8", "--remote"]);
  const r2Assets = assetPaths.map((assetPath) => runWrangler([
    "r2", "object", "put", `${R2_BUCKET}/${cfg.dir}/${id}/${assetPath}`, "--file", join(destDir, assetPath), "--content-type", contentTypeForPath(assetPath), "--remote",
  ]));
  const pagesDeploy = runWrangler(["pages", "deploy", "public", "--project-name", PAGES_PROJECT, "--commit-dirty=true"]);
  const payload = {
    ok: true, command: "publish", section: cfg.dir, indexKey: cfg.key, id, title: meta.title, date,
    publishedAtKst: publishedAtKst(date), sourceHtmlPath, assetPaths, assetCount: assetPaths.length,
    publicUrl: `${PAGES_ORIGIN}/${cfg.dir}/${id}/index.html`, r2Url: `${R2_PUBLIC}/${cfg.dir}/${id}/index.html`,
    pagesIndexUrl: `${PAGES_ORIGIN}/index.json`, beforeCounts, afterCounts, buildIndexRan: true,
    nonEmptySections: nonEmptySections(afterCounts), decreasedSections: decreasedSections(beforeCounts, afterCounts),
    r2HtmlResult: r2Html.slice(-1000), r2ManifestResult: r2Manifest.slice(-1000),
    r2AssetResults: r2Assets.map((result) => result.slice(-300)), pagesDeployResult: pagesDeploy.slice(-1500),
  };
  payload.artifactPath = writeResultFile("manual-onboarding-publish-result.json", payload);
  jsonOut(payload);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!response.ok) fail("HTTP JSON fetch failed", { url, status: response.status });
  return response.json();
}

function cacheBust(url, token) {
  const parsed = new URL(url);
  parsed.searchParams.set("v", token);
  return parsed.toString();
}

async function verify(opts) {
  const cfg = normalizeSection(requireString(opts, "section"));
  const id = requireString(opts, "id");
  const attempts = Math.max(1, Number.parseInt(process.env.MANUAL_ONBOARDING_VERIFY_ATTEMPTS || "5", 10) || 5);
  const delayMs = Math.max(0, Number.parseInt(process.env.MANUAL_ONBOARDING_VERIFY_DELAY_MS || "1000", 10) || 0);
  let index = null;
  let entry = null;
  let indexAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    indexAttempts = attempt;
    index = await fetchJson(cacheBust(`${PAGES_ORIGIN}/index.json`, `${Date.now()}-${attempt}`));
    entry = (Array.isArray(index[cfg.key]) ? index[cfg.key] : []).find((item) => item?.id === id) ?? null;
    if (entry || attempt === attempts) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }

  let expectation;
  try {
    expectation = resolveVerificationExpectation({
      expectedDate: opts.expectedDate, publishResultPath: opts.publishResultPath,
      section: cfg.dir, id, entry, pagesOrigin: PAGES_ORIGIN, r2Public: R2_PUBLIC,
      workProductRoot: WORK_PRODUCT_ROOT,
    });
  } catch (error) {
    fail(error.message);
  }
  const token = `${Date.now()}`;
  const [publicResponse, r2Response] = await Promise.all([
    fetch(cacheBust(expectation.publicUrl, token), { cache: "no-store", headers: { "cache-control": "no-cache" } }),
    fetch(cacheBust(expectation.r2Url, token), { cache: "no-store", headers: { "cache-control": "no-cache" } }),
  ]);
  const [publicHtml, r2Html] = await Promise.all([publicResponse.text(), r2Response.text()]);
  const publicEvidence = extractPublicationHtmlEvidence(publicHtml);
  const r2Evidence = extractPublicationHtmlEvidence(r2Html);
  const liveCounts = countsFromIndex(index);
  const emptySections = REQUIRED_KEYS.filter((key) => Number(liveCounts[key] || 0) <= 0);
  const decreased = expectation.beforeCounts ? decreasedSections(expectation.beforeCounts, liveCounts) : [];
  const catalogTitle = entry?.title ?? null;
  const catalogDate = entry?.date ?? null;
  const catalogTitleOk = !expectation.expectedTitle || catalogTitle === expectation.expectedTitle;
  const titleContractOk = expectation.expectedTitle
    ? catalogTitleOk && publicEvidence.title === expectation.expectedTitle && r2Evidence.title === expectation.expectedTitle
    : Boolean(publicEvidence.title) && publicEvidence.title === r2Evidence.title;
  const publishResultDateOk = !expectation.publishResult || (
    expectation.publishResult.date === expectation.expectedDate
    && expectation.publishResult.publishedAtKst === publishedAtKst(expectation.expectedDate)
  );
  const kstDateContractOk = expectation.dateContractRequired && publishResultDateOk
    && catalogDate === expectation.expectedDate && titleContractOk
    && publicationEvidenceMatches(publicEvidence, expectation.expectedDate, expectation.expectedTitle)
    && publicationEvidenceMatches(r2Evidence, expectation.expectedDate, expectation.expectedTitle);
  const healthyDelivery = publicResponse.status === 200 && r2Response.status === 200 && Boolean(entry)
    && emptySections.length === 0 && decreased.length === 0;
  const ok = healthyDelivery && (!expectation.dateContractRequired || kstDateContractOk);
  const payload = {
    ok, command: "verify", section: cfg.dir, indexKey: cfg.key, id,
    dateContractRequired: expectation.dateContractRequired,
    expectedDate: expectation.expectedDate, expectedTitle: expectation.expectedTitle,
    catalogDate, catalogTitle, titleContractOk,
    liveCounts, nonEmptySections: nonEmptySections(liveCounts), emptySections, decreasedSections: decreased,
    indexAttempts, indexHasEntry: Boolean(entry), entry,
    publicUrl: expectation.publicUrl, publicDetailStatus: publicResponse.status,
    publicTitle: publicEvidence.title, publicWrittenDate: publicEvidence.writtenDate,
    publicDateMeta: publicEvidence.dateMeta, publicPublishedTimeMeta: publicEvidence.publishedTimeMeta,
    publicSeoulDate: publicEvidence.seoulDate, publicUtcOffset: publicEvidence.utcOffset,
    r2Url: expectation.r2Url, r2Status: r2Response.status,
    r2Title: r2Evidence.title, r2WrittenDate: r2Evidence.writtenDate,
    r2DateMeta: r2Evidence.dateMeta, r2PublishedTimeMeta: r2Evidence.publishedTimeMeta,
    r2SeoulDate: r2Evidence.seoulDate, r2UtcOffset: r2Evidence.utcOffset,
    kstDateContractOk,
  };
  payload.artifactPath = writeResultFile("manual-onboarding-publish-verification.json", payload);
  jsonOut(payload);
  if (!ok) process.exit(1);
}

const { command, opts } = parseArgs(process.argv.slice(2));
if (command === "publish") await publish(opts);
else if (command === "verify") await verify(opts);
else fail("Unknown command", { command, allowedCommands: ["publish", "verify"] });
