import test from "node:test";
import assert from "node:assert/strict";

import {
  KST_CRON_EXPRESSIONS,
  SOURCE_REQUESTS,
  buildWorkflow,
  isAllowedKstSlot,
  normalizeDramLastUpdate,
  sha256Hex,
} from "./workflow-definition.mjs";
import { readSyncConfig } from "./sync-workflow.mjs";

const credentials = {
  minioCredentialId: "minio-id",
  webhookCredentialId: "webhook-id",
  a1CredentialId: "a1-id",
};

function workflowByName() {
  const workflow = buildWorkflow(credentials);
  const byName = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
  return { workflow, byName };
}

function outgoing(workflow, name) {
  return (workflow.connections[name]?.main ?? []).flat().map((edge) => edge.node);
}

function reaches(workflow, from, target) {
  const pending = [from];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...outgoing(workflow, current));
  }
  return false;
}

test("schedule expressions cover the approved KST window", () => {
  assert.deepEqual(KST_CRON_EXPRESSIONS, [
    "0,30 9-23 * * 1",
    "0,30 * * * 2-5",
    "0,30 0-5 * * 6",
    "0 6 * * 6",
  ]);
});

test("KST guard includes both boundaries and excludes outside slots", () => {
  assert.equal(isAllowedKstSlot("2026-07-20T08:30:00+09:00"), false);
  assert.equal(isAllowedKstSlot("2026-07-20T09:00:00+09:00"), true);
  assert.equal(isAllowedKstSlot("2026-07-25T06:00:00+09:00"), true);
  assert.equal(isAllowedKstSlot("2026-07-25T06:30:00+09:00"), false);
  assert.equal(isAllowedKstSlot("2026-07-26T12:00:00+09:00"), false);
  assert.throws(() => isAllowedKstSlot("not-a-date"), /invalid schedule timestamp/);
});

test("SHA-256 helper matches the standard abc vector and is embedded unchanged", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const code = workflowByName().byName["Normalize observation"].parameters.jsCode;
  assert.equal(code.includes(sha256Hex.toString()), true);
});

test("DRAMeXchange Last Update text becomes an aware ISO timestamp", () => {
  assert.equal(normalizeDramLastUpdate("Last Update : Jul.17 2026 18:10 (GMT+8)"), "2026-07-17T18:10:00+08:00");
  assert.throws(() => normalizeDramLastUpdate("Last Update: unavailable"), /Last Update/);
  const code = workflowByName().byName["Build current draft"].parameters.jsCode;
  assert.equal(code.includes(normalizeDramLastUpdate.toString()), true);
});

test("source list covers dashboard cards without weekly freight requests", () => {
  const yahoo = SOURCE_REQUESTS.filter((item) => item.kind === "yahoo");
  assert.deepEqual(yahoo.map((item) => item.symbol), [
    "YM=F", "NQ=F", "ES=F", "RTY=F", "^VIX", "DX-Y.NYB", "^TNX", "CL=F", "BZ=F", "GC=F",
    "^KS11", "^KS200", "EWY", "USDKRW=X", "KRW=F", "^SOX", "BDRY", "HG=F", "NG=F", "URA",
  ]);
  assert.equal(SOURCE_REQUESTS.some((item) => /scfi|ccfi/i.test(`${item.key} ${item.url}`)), false);
  assert.equal(SOURCE_REQUESTS.some((item) => item.key === "ddr5" && item.url === "https://www.dramexchange.com/"), true);
  assert.equal(SOURCE_REQUESTS.some((item) => item.key === "fear_greed" && item.url.includes("alternative.me")), true);
});

test("source fetch uses the exact serial batching configuration", () => {
  const fetch = workflowByName().byName["Fetch market sources"];
  assert.deepEqual(fetch.parameters.options, {
    batching: { batch: { batchSize: 1, batchInterval: 1500 } },
    timeout: 30_000,
    response: { response: { neverError: true, responseFormat: "text" } },
  });
});

test("workflow has the fixed nodes, versions, authenticated paths, and KST settings", () => {
  const { workflow, byName } = workflowByName();
  assert.equal(workflow.name, "Gazua - Market Pulse 30m Collect and A1 Sync");
  assert.deepEqual(workflow.settings, { executionOrder: "v1", timezone: "Asia/Seoul", availableInMCP: false });
  assert.deepEqual(workflow.nodes.map((node) => node.name), [
    "KST Schedule", "Mark scheduled run", "Manual Test Webhook", "Mark manual run", "KST execution guard",
    "Build source requests", "Fetch market sources", "Build current draft", "Download previous latest",
    "Extract previous latest", "Normalize observation", "Prepare storage plan", "Should write history?",
    "Prepare history binary", "Store history", "Prepare latest binary", "Update latest", "Call A1 ingest",
    "Verify public market pulse", "Build sync receipt", "Prepare receipt binary", "Store sync receipt",
    "Assert synchronization", "DDR5 changed?", "Prepare DDR5 change binary", "Store DDR5 change event",
  ]);
  assert.deepEqual(byName["KST Schedule"].parameters.rule.interval.map((item) => item.expression), KST_CRON_EXPRESSIONS);
  assert.equal(byName["KST Schedule"].typeVersion, 1.2);
  assert.equal(byName["Manual Test Webhook"].typeVersion, 2.1);
  assert.equal(byName["Manual Test Webhook"].parameters.authentication, "headerAuth");
  assert.equal(byName["Manual Test Webhook"].parameters.responseMode, "lastNode");
  assert.equal(byName["Manual Test Webhook"].parameters.path, "papercompany/gazua-market-pulse-30m");
  assert.equal(byName["Manual Test Webhook"].credentials.httpHeaderAuth.id, "webhook-id");
  assert.equal(byName["Call A1 ingest"].credentials.httpHeaderAuth.id, "a1-id");
});

test("workflow reads prior latest and validates cumulative observation", () => {
  const { byName } = workflowByName();
  assert.deepEqual(byName["Download previous latest"].parameters, {
    resource: "file", operation: "download", bucketName: "data",
    fileKey: "gazua/market-pulse/latest.json", binaryPropertyName: "data",
  });
  assert.equal(byName["Download previous latest"].credentials.s3.id, "minio-id");
  assert.equal(byName["Download previous latest"].onError, "continueRegularOutput");
  assert.deepEqual(byName["Extract previous latest"].parameters, {
    operation: "fromJson", binaryPropertyName: "data", destinationKey: "previous", options: { keepSource: "json" },
  });
  const code = byName["Normalize observation"].parameters.jsCode;
  assert.match(code, /gazua\.market-pulse\.v1/);
  assert.match(code, /contentSha256/);
  assert.match(code, /carriedForward/);
  assert.match(code, /recursively sorted|canonical/);
  assert.match(code, /status\.key === "fear_greed"/);
  assert.match(code, /status\.key === "ddr5"/);
  assert.match(code, /carriedForward\.push\(status\.key\)/);
  assert.match(code, /commodities\[commodityKey\].*stale: true/);
});

test("collection supports fixed partial-failure override and every value mapping", () => {
  const { byName } = workflowByName();
  const manual = byName["Mark manual run"].parameters.jsCode;
  assert.match(manual, /Copper/);
  assert.match(manual, /NaturalGas/);
  assert.match(manual, /Uranium_ETF/);
  assert.match(manual, /manual.*true/s);
  assert.match(byName["Build source requests"].parameters.jsCode, /127\.0\.0\.1\.invalid\/forced-failure/);
  const collectionCode = byName["Build source requests"].parameters.jsCode + "\n" + byName["Build current draft"].parameters.jsCode;
  for (const token of ["instrument_macro", "instrument_commodity:Gold", "KRW_USD_Exchange", "US_10Y_Treasury", "DDR5 16Gb (2Gx8) 4800/5600", "Last Update", "fear_greed"]) {
    assert.match(collectionCode, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
  }
  assert.match(collectionCode, /cells\[5\]/);
  assert.doesNotMatch(collectionCode, /cells\[1\]/);
  assert.match(collectionCode, /observedAt: sourceUpdatedAt/);
  assert.match(collectionCode, /commodities.*observedAt, stale: false/);
  assert.equal(byName["Fetch market sources"].onError, "continueRegularOutput");
  assert.equal(byName["Fetch market sources"].parameters.options.timeout, 30_000);
  assert.equal(byName["Fetch market sources"].parameters.options.response.response.neverError, true);
});

test("MinIO writes DDR5 changes and history before latest, then always writes a receipt", () => {
  const { workflow, byName } = workflowByName();
  for (const name of ["Store history", "Update latest", "Store sync receipt", "Store DDR5 change event"]) {
    assert.equal(byName[name].type, "n8n-nodes-base.s3");
    assert.equal(byName[name].typeVersion, 1);
    assert.equal(byName[name].credentials.s3.id, "minio-id");
    assert.equal(byName[name].parameters.bucketName, "data");
  }
  const storage = byName["Prepare storage plan"].parameters.jsCode;
  for (const key of ["gazua/market-pulse/history", "gazua/market-pulse/latest.json", "sync-receipts", "ddr5-changes", "shouldWriteHistory"]) assert.match(storage, new RegExp(key.replaceAll("/", "\\/")));
  assert.deepEqual(outgoing(workflow, "Store history"), ["Prepare latest binary"]);
  assert.deepEqual(outgoing(workflow, "Update latest"), ["Call A1 ingest"]);
  assert.deepEqual(outgoing(workflow, "Store sync receipt"), ["Assert synchronization"]);
  assert.deepEqual(outgoing(workflow, "DDR5 changed?"), ["Prepare DDR5 change binary", "Should write history?"]);
});

test("A1 call uses Header Auth, public verification, and failure-safe receipts", () => {
  const { workflow, byName } = workflowByName();
  const text = JSON.stringify(workflow);
  const call = byName["Call A1 ingest"];
  assert.equal(call.parameters.method, "POST");
  assert.equal(call.parameters.url, "https://gazua.showk.ing/api/internal/market-pulse/ingest");
  assert.equal(call.parameters.authentication, "genericCredentialType");
  assert.equal(call.parameters.genericAuthType, "httpHeaderAuth");
  assert.equal(call.parameters.jsonBody, "={{ $('Normalize observation').first().json.observation }}");
  assert.equal(call.parameters.options.response.response.fullResponse, true);
  assert.equal(call.parameters.options.response.response.neverError, true);
  assert.equal(call.onError, "continueRegularOutput");
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9_-]{16,}/);
  assert.equal(byName["Verify public market pulse"].parameters.url, "https://gazua.showk.ing/api/market-pulse");
  assert.match(byName["Build sync receipt"].parameters.jsCode, /gazua\.market-pulse-sync-receipt\.v1/);
  assert.match(byName["Assert synchronization"].parameters.jsCode, /throw new Error/);
});

test("both triggers and every node reach synchronization assertion", () => {
  const { workflow } = workflowByName();
  for (const trigger of ["KST Schedule", "Manual Test Webhook"]) assert.equal(reaches(workflow, trigger, "Assert synchronization"), true, trigger);
  for (const node of workflow.nodes) assert.equal(reaches(workflow, node.name, "Assert synchronization"), true, node.name);
});

test("workflow definition contains no embedded secret, execution node, or local data path", () => {
  const text = JSON.stringify(buildWorkflow(credentials));
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9_-]{16,}|n8n-nodes-base\.executeCommand|\/Users\/|\/tmp\//);
  assert.doesNotMatch(text, /Shanghai Shipping Exchange|currentIndex\?indexName=/i);
});

test("sync config requires all credential IDs", () => {
  const base = {
    N8N_MINIO_CREDENTIAL_ID: "minio-id", N8N_GAZUA_WEBHOOK_CREDENTIAL_ID: "webhook-id",
    N8N_GAZUA_A1_CREDENTIAL_ID: "a1-id", N8N_API_KEY_FILE: "/tmp/n8n-key",
  };
  for (const key of ["N8N_MINIO_CREDENTIAL_ID", "N8N_GAZUA_WEBHOOK_CREDENTIAL_ID", "N8N_GAZUA_A1_CREDENTIAL_ID"]) {
    const env = { ...base };
    delete env[key];
    assert.throws(() => readSyncConfig(env, { readFile: () => "api-key" }), new RegExp(key));
  }
});

test("sync config reads the API key through the injected reader", () => {
  const seen = [];
  const config = readSyncConfig({
    N8N_MINIO_CREDENTIAL_ID: "minio-id", N8N_GAZUA_WEBHOOK_CREDENTIAL_ID: "webhook-id",
    N8N_GAZUA_A1_CREDENTIAL_ID: "a1-id", N8N_API_KEY_FILE: "/protected/key",
  }, { readFile: (path) => { seen.push(path); return " api-key\n"; } });
  assert.deepEqual(seen, ["/protected/key"]);
  assert.equal(config.apiKey, "api-key");
});
