import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentTypeForPath, stageSourceAssets } from "../manual-onboarding-assets.mjs";
import {
  extractPublicationHtmlEvidence,
  normalizePublicationHtml,
  publishedAtKst,
  resolvePublicationDate,
  resolveVerificationExpectation,
} from "../publication-date-contract.mjs";

test("defaults publication date in Seoul and rejects invalid calendar dates", () => {
  assert.equal(resolvePublicationDate(undefined, new Date("2026-07-16T15:30:00Z")), "2026-07-17");
  assert.equal(resolvePublicationDate("2026-07-17"), "2026-07-17");
  assert.throws(() => resolvePublicationDate("2026-02-30"), /YYYY-MM-DD/);
  assert.equal(publishedAtKst("2026-07-17"), "2026-07-17T00:00:00+09:00");
});

test("normalizes destination HTML date evidence without changing the source value", () => {
  const source = `<!doctype html><html><head>
<title>보안 루프</title>
<meta name="date" content="2026-07-16">
<meta content="2026-07-16T00:00:00Z" property="article:published_time">
</head><body><time datetime="2026-07-16T00:00:00Z">작성일: 2026-07-16 (KST)</time></body></html>`;
  const normalized = normalizePublicationHtml(source, "2026-07-17");
  const evidence = extractPublicationHtmlEvidence(normalized);

  assert.match(source, /content="2026-07-16"/);
  assert.equal(evidence.title, "보안 루프");
  assert.equal(evidence.writtenDate, "2026-07-17");
  assert.equal(evidence.timeDatetime, "2026-07-17T00:00:00+09:00");
  assert.equal(evidence.dateMeta, "2026-07-17T00:00:00+09:00");
  assert.equal(evidence.publishedTimeMeta, "2026-07-17T00:00:00+09:00");
  assert.equal(evidence.seoulDate, "2026-07-17");
  assert.equal(evidence.utcOffset, "+09:00");
});

test("preserves nested asset staging and content types from the A1 tool", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "manual-onboarding-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source-assets");
  const destination = join(root, "published-detail");
  await mkdir(join(source, "charts"), { recursive: true });
  await writeFile(join(source, "hero.jpg"), "hero");
  await writeFile(join(source, "charts", "trend.svg"), "chart");

  assert.deepEqual(await stageSourceAssets(source, destination), ["assets/charts/trend.svg", "assets/hero.jpg"]);
  assert.equal(await readFile(join(destination, "assets", "hero.jpg"), "utf8"), "hero");
  assert.equal(contentTypeForPath("assets/charts/trend.svg"), "image/svg+xml");
  assert.equal(contentTypeForPath("assets/hero.jpg"), "image/jpeg");
});

test("verification accepts publish results only from the work-product root and exact destinations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "manual-onboarding-contract-"));
  const outside = await mkdtemp(join(tmpdir(), "manual-onboarding-contract-outside-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const payload = {
    section: "tech-scout", id: "safe-id", title: "안전한 제목", date: "2026-07-17",
    publicUrl: "https://evil.example/detail.html",
    r2Url: "https://r2.example/tech-scout/safe-id/index.html",
  };
  const outsidePath = join(outside, "publish-result.json");
  const insidePath = join(root, "publish-result.json");
  await writeFile(outsidePath, JSON.stringify(payload));
  await writeFile(insidePath, JSON.stringify(payload));
  const linkedPath = join(root, "linked-publish-result.json");
  await symlink(outsidePath, linkedPath);
  const input = {
    section: "tech-scout", id: "safe-id", entry: { date: "2026-07-17", title: "안전한 제목" },
    pagesOrigin: "https://pages.example/onboarding", r2Public: "https://r2.example", workProductRoot: root,
  };

  assert.throws(
    () => resolveVerificationExpectation({ ...input, publishResultPath: outsidePath }),
    /publishResultPath must be inside/,
  );
  assert.throws(
    () => resolveVerificationExpectation({ ...input, publishResultPath: linkedPath }),
    /publishResultPath must not be a symbolic link/,
  );
  assert.throws(
    () => resolveVerificationExpectation({ ...input, publishResultPath: insidePath }),
    /publicUrl does not match the configured publication destination/,
  );
});
