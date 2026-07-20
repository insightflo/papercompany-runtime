import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TOOL_PATH = fileURLToPath(new URL("../manual-onboarding-workflow-tool.mjs", import.meta.url));
const ID = "2026-07-17-security-loop";
const DATE = "2026-07-17";
const TITLE = "공격자와 방어자가 함께 연습하는 에이전트 보안 루프";
const COUNTS = { tech_news: 1, tech_scout: 1, manuals: 1, concepts: 1 };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function html(date = DATE, title = TITLE) {
  const publishedAt = `${date}T00:00:00+09:00`;
  return `<!doctype html><html><head><title>${title}</title><meta name="date" content="${publishedAt}"><meta property="article:published_time" content="${publishedAt}"></head><body><time datetime="${publishedAt}">작성일: ${date} (KST)</time></body></html>`;
}

function indexWith(entry) {
  return {
    tech_news: [{ id: "news" }],
    tech_scout: [entry],
    manuals: [{ id: "manual" }],
    concepts: [{ id: "concept" }],
  };
}

function runVerifier({ env, publishResultPath, expectedDate } = {}) {
  const args = [TOOL_PATH, "verify", "--id", ID, "--section", "tech-scout"];
  if (publishResultPath) args.push("--publish-result-path", publishResultPath);
  if (expectedDate) args.push("--expected-date", expectedDate);
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return once(child, "close").then(([code]) => ({ code, stdout, stderr, payload: JSON.parse(stdout) }));
}

function runPublisher(args, env) {
  const child = spawn(process.execPath, [TOOL_PATH, "publish", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return once(child, "close").then(([code]) => ({ code, stdout, stderr, payload: JSON.parse(stdout) }));
}

test("verify retries the catalog and consumes exact publish-result URLs with direct KST HTML evidence", async (context) => {
  let indexRequests = 0;
  const publicRequests = [];
  const r2Requests = [];
  let r2Html = html();
  const pagesServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/onboarding/index.json") {
      indexRequests += 1;
      const entry = indexRequests === 1 ? { id: "older", date: DATE } : { id: ID, date: DATE, title: TITLE };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(indexWith(entry)));
      return;
    }
    publicRequests.push(url.pathname);
    res.statusCode = url.pathname === `/onboarding/tech-scout/${ID}/index.html` ? 200 : 404;
    res.end(html());
  });
  const r2Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    r2Requests.push(url.pathname);
    res.statusCode = url.pathname === `/tech-scout/${ID}/index.html` ? 200 : 404;
    res.end(r2Html);
  });
  context.after(() => { pagesServer.close(); r2Server.close(); });
  const pagesOrigin = await listen(pagesServer);
  const r2Origin = await listen(r2Server);
  const root = await mkdtemp(join(tmpdir(), "manual-onboarding-result-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const publishResultPath = join(root, "publish-result.json");
  await writeFile(publishResultPath, JSON.stringify({
    command: "publish", section: "tech-scout", id: ID, title: TITLE, date: DATE,
    publishedAtKst: `${DATE}T00:00:00+09:00`, beforeCounts: COUNTS,
    publicUrl: `${pagesOrigin}/onboarding/tech-scout/${ID}/index.html`, r2Url: `${r2Origin}/tech-scout/${ID}/index.html`,
  }));
  const env = {
    MANUAL_ONBOARDING_PAGES_ORIGIN: `${pagesOrigin}/onboarding`,
    MANUAL_ONBOARDING_R2_PUBLIC: r2Origin,
    MANUAL_ONBOARDING_WORK_PRODUCT_ROOT: root,
    MANUAL_ONBOARDING_VERIFY_ATTEMPTS: "3",
    MANUAL_ONBOARDING_VERIFY_DELAY_MS: "1",
  };

  const result = await runVerifier({ env, publishResultPath });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(indexRequests, 2);
  assert.deepEqual(publicRequests, [`/onboarding/tech-scout/${ID}/index.html`]);
  assert.deepEqual(r2Requests, [`/tech-scout/${ID}/index.html`]);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.expectedDate, DATE);
  assert.equal(result.payload.publicTitle, TITLE);
  assert.equal(result.payload.publicWrittenDate, DATE);
  assert.equal(result.payload.publicDateMeta, `${DATE}T00:00:00+09:00`);
  assert.equal(result.payload.publicPublishedTimeMeta, `${DATE}T00:00:00+09:00`);
  assert.equal(result.payload.publicSeoulDate, DATE);
  assert.equal(result.payload.publicUtcOffset, "+09:00");
  assert.equal(result.payload.r2Title, TITLE);
  assert.equal(result.payload.catalogDate, DATE);
  assert.equal(result.payload.kstDateContractOk, true);

  r2Html = html("2026-07-16");
  const mismatch = await runVerifier({ env, publishResultPath, expectedDate: DATE });
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.payload.ok, false);
  assert.equal(mismatch.payload.kstDateContractOk, false);
});

test("verify preserves old callers by deriving expected date from the catalog entry", async (context) => {
  const pagesServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/onboarding/index.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(indexWith({ id: ID, date: DATE, title: TITLE })));
      return;
    }
    res.statusCode = url.pathname === `/onboarding/tech-scout/${ID}/index.html` ? 200 : 404;
    res.end(html());
  });
  const r2Server = createServer((req, res) => { res.statusCode = 200; res.end(html()); });
  context.after(() => { pagesServer.close(); r2Server.close(); });
  const pagesOrigin = await listen(pagesServer);
  const r2Origin = await listen(r2Server);
  const result = await runVerifier({ env: {
    MANUAL_ONBOARDING_PAGES_ORIGIN: `${pagesOrigin}/onboarding`,
    MANUAL_ONBOARDING_R2_PUBLIC: r2Origin,
    MANUAL_ONBOARDING_VERIFY_ATTEMPTS: "1",
    MANUAL_ONBOARDING_VERIFY_DELAY_MS: "0",
  } });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.payload.expectedDate, DATE);
  assert.equal(result.payload.catalogDate, DATE);
  assert.equal(result.payload.kstDateContractOk, true);
});

test("verify keeps truly legacy callers healthy while returning missing direct date evidence", async (context) => {
  const pagesServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/onboarding/index.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(indexWith({ id: ID })));
      return;
    }
    res.statusCode = 200;
    res.end("ok");
  });
  const r2Server = createServer((_req, res) => { res.statusCode = 200; res.end("ok"); });
  context.after(() => { pagesServer.close(); r2Server.close(); });
  const pagesOrigin = await listen(pagesServer);
  const r2Origin = await listen(r2Server);
  const result = await runVerifier({ env: {
    MANUAL_ONBOARDING_PAGES_ORIGIN: `${pagesOrigin}/onboarding`,
    MANUAL_ONBOARDING_R2_PUBLIC: r2Origin,
    MANUAL_ONBOARDING_VERIFY_ATTEMPTS: "1",
    MANUAL_ONBOARDING_VERIFY_DELAY_MS: "0",
  } });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dateContractRequired, false);
  assert.equal(result.payload.kstDateContractOk, false);
  assert.equal(result.payload.publicDateMeta, null);
  assert.equal(result.payload.publicPublishedTimeMeta, null);
  assert.equal(result.payload.r2DateMeta, null);
  assert.equal(result.payload.catalogDate, null);
});

test("strict verify requires the exact publish-result artifact instead of guessing detail URLs", async (context) => {
  let detailRequests = 0;
  const pagesServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/onboarding/index.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(indexWith({ id: ID, date: DATE, title: TITLE })));
      return;
    }
    detailRequests += 1;
    res.end(html());
  });
  const r2Server = createServer((_req, res) => { detailRequests += 1; res.end(html()); });
  context.after(() => { pagesServer.close(); r2Server.close(); });
  const pagesOrigin = await listen(pagesServer);
  const r2Origin = await listen(r2Server);
  const result = await runVerifier({
    expectedDate: DATE,
    env: {
      MANUAL_ONBOARDING_PAGES_ORIGIN: `${pagesOrigin}/onboarding`,
      MANUAL_ONBOARDING_R2_PUBLIC: r2Origin,
      MANUAL_ONBOARDING_VERIFY_ATTEMPTS: "1",
      MANUAL_ONBOARDING_VERIFY_DELAY_MS: "0",
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.payload.error, /expectedDate requires publishResultPath/);
  assert.equal(detailRequests, 0);
});

test("publish rejects source files outside the work-product root and symbolic-link bypasses", async (context) => {
  const allowedRoot = await mkdtemp(join(tmpdir(), "manual-onboarding-allowed-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "manual-onboarding-outside-"));
  context.after(() => Promise.all([
    rm(allowedRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]));
  const sourceHtmlPath = join(outsideRoot, "index.html");
  await writeFile(sourceHtmlPath, html());
  const result = await runPublisher([
    "--section", "tech-scout", "--id", ID, "--source-html-path", sourceHtmlPath,
  ], { MANUAL_ONBOARDING_WORK_PRODUCT_ROOT: allowedRoot });

  assert.equal(result.code, 1);
  assert.match(result.payload.error, /sourceHtmlPath workProduct must be inside/);

  const linkedSourcePath = join(allowedRoot, "linked-index.html");
  await symlink(sourceHtmlPath, linkedSourcePath);
  const linkedResult = await runPublisher([
    "--section", "tech-scout", "--id", ID, "--source-html-path", linkedSourcePath,
  ], { MANUAL_ONBOARDING_WORK_PRODUCT_ROOT: allowedRoot });
  assert.equal(linkedResult.code, 1);
  assert.match(linkedResult.payload.error, /must not be a symbolic link/);
});

test("publish rejects path-segment ids that would target a section root", async () => {
  for (const badId of [".", ".."]) {
    const result = await runPublisher(["--section", "tech-scout", "--id", badId]);
    assert.equal(result.code, 1, `id=${badId} should be rejected: ${result.stderr || result.stdout}`);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.error, /safe detail slug|path segment|strict child/i);
  }
});

test("strict verify compares catalog title to publish-result title and returns title-contract evidence", async (context) => {
  const pagesServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/onboarding/index.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(indexWith({ id: ID, date: DATE, title: "잘못된 카탈로그 제목" })));
      return;
    }
    res.statusCode = 200;
    res.end(html());
  });
  const r2Server = createServer((_req, res) => { res.statusCode = 200; res.end(html()); });
  context.after(() => { pagesServer.close(); r2Server.close(); });
  const pagesOrigin = await listen(pagesServer);
  const r2Origin = await listen(r2Server);
  const root = await mkdtemp(join(tmpdir(), "manual-onboarding-title-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const publishResultPath = join(root, "publish-result.json");
  await writeFile(publishResultPath, JSON.stringify({
    command: "publish", section: "tech-scout", id: ID, title: TITLE, date: DATE,
    publishedAtKst: `${DATE}T00:00:00+09:00`, beforeCounts: COUNTS,
    publicUrl: `${pagesOrigin}/onboarding/tech-scout/${ID}/index.html`, r2Url: `${r2Origin}/tech-scout/${ID}/index.html`,
  }));
  const result = await runVerifier({
    env: {
      MANUAL_ONBOARDING_PAGES_ORIGIN: `${pagesOrigin}/onboarding`,
      MANUAL_ONBOARDING_R2_PUBLIC: r2Origin,
      MANUAL_ONBOARDING_WORK_PRODUCT_ROOT: root,
      MANUAL_ONBOARDING_VERIFY_ATTEMPTS: "1",
      MANUAL_ONBOARDING_VERIFY_DELAY_MS: "0",
    },
    publishResultPath,
  });

  assert.equal(result.code, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.catalogTitle, "잘못된 카탈로그 제목");
  assert.equal(result.payload.expectedTitle, TITLE);
  assert.equal(result.payload.titleContractOk, false);
  assert.equal(result.payload.kstDateContractOk, false);
});
