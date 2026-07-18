export const KST_CRON_EXPRESSIONS = [
  "0,30 9-23 * * 1",
  "0,30 * * * 2-5",
  "0,30 0-5 * * 6",
  "0 6 * * 6",
];

const yahoo = [
  ["YM", "YM=F", "instrument"], ["NQ", "NQ=F", "instrument"], ["ES", "ES=F", "instrument"],
  ["RTY", "RTY=F", "instrument"], ["VIX", "^VIX", "instrument_macro"], ["DXY", "DX-Y.NYB", "instrument"],
  ["US10Y", "^TNX", "instrument_macro"], ["CL", "CL=F", "instrument"], ["brent_crude", "BZ=F", "instrument"],
  ["GC", "GC=F", "instrument_commodity:Gold"], ["KOSPI", "^KS11", "instrument"], ["KOSPI200", "^KS200", "instrument"],
  ["EWY", "EWY", "instrument"], ["USDKRW", "USDKRW=X", "instrument_macro"], ["KRW", "KRW=F", "instrument"],
  ["SOX", "^SOX", "instrument"], ["BDRY", "BDRY", "instrument"], ["Copper", "HG=F", "commodity"],
  ["NaturalGas", "NG=F", "commodity"], ["Uranium_ETF", "URA", "commodity"],
];

export const SOURCE_REQUESTS = [
  ...yahoo.map(([key, symbol, target]) => ({
    kind: "yahoo", key, symbol, target,
    url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`,
  })),
  { kind: "fear_greed", key: "fear_greed", url: "https://api.alternative.me/fng/?limit=2&format=json" },
  { kind: "ddr5", key: "ddr5", url: "https://www.dramexchange.com/" },
];

function kstParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid schedule timestamp");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

export function isAllowedKstSlot(value) {
  const { weekday, hour, minute } = kstParts(value);
  if (![0, 30].includes(minute)) return false;
  if (weekday === "Mon") return hour >= 9;
  if (["Tue", "Wed", "Thu", "Fri"].includes(weekday)) return true;
  if (weekday === "Sat") return hour < 6 || (hour === 6 && minute === 0);
  return false;
}

export function normalizeDramLastUpdate(value) {
  const match = String(value ?? "").match(/Last Update\s*:?\s*([A-Za-z]{3})\.?\s*([0-9]{1,2})\s+([0-9]{4})\s+([0-9]{1,2}):([0-9]{2})\s*\(GMT\s*([+-])\s*([0-9]{1,2})(?::?([0-9]{2}))?\)/iu);
  if (!match) throw new Error("DRAMeXchange Last Update text was not found");
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const monthName = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  const month = months[monthName]; const day = Number(match[2]); const year = Number(match[3]); const hour = Number(match[4]); const minute = Number(match[5]); const offsetHour = Number(match[7]); const offsetMinute = Number(match[8] ?? 0);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (!month || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) throw new Error("DRAMeXchange Last Update text was invalid");
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0") + "T" + String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0") + ":00" + match[6] + String(offsetHour).padStart(2, "0") + ":" + String(offsetMinute).padStart(2, "0");
}

export function sha256Hex(message) {
  const bytes = new TextEncoder().encode(message); const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]; const hash = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]); const length = Math.ceil((bytes.length + 9) / 64) * 64; const data = new Uint8Array(length); data.set(bytes); data[bytes.length] = 0x80; const view = new DataView(data.buffer); const bits = bytes.length * 8; view.setUint32(length - 8, Math.floor(bits / 0x100000000), false); view.setUint32(length - 4, bits >>> 0, false); const words = new Uint32Array(64); const rotate = (value, count) => (value >>> count) | (value << (32 - count));
  for (let offset = 0; offset < length; offset += 64) { for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false); for (let i = 16; i < 64; i += 1) { const a = words[i-15], b = words[i-2]; words[i] = (words[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) >>> 0; } let [a,b,c,d,e,f,g,h] = hash; for (let i = 0; i < 64; i += 1) { const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^((~e)&g)) + constants[i] + words[i]) >>> 0; const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0; h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; } hash[0]=(hash[0]+a)>>>0; hash[1]=(hash[1]+b)>>>0; hash[2]=(hash[2]+c)>>>0; hash[3]=(hash[3]+d)>>>0; hash[4]=(hash[4]+e)>>>0; hash[5]=(hash[5]+f)>>>0; hash[6]=(hash[6]+g)>>>0; hash[7]=(hash[7]+h)>>>0; }
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
}

const MARK_SCHEDULED_CODE = String.raw`return [{ json: { ...$json, runKind: "scheduled", manual: false, testFailKey: null } }];`;
const MARK_MANUAL_CODE = String.raw`const input = $json.body && typeof $json.body === "object" ? $json.body : $json;
if (input.manual !== true) throw new Error("Manual webhook requires JSON body {manual:true}");
const allowedFailures = new Set(["Copper", "NaturalGas", "Uranium_ETF"]);
const testFailKey = input.testFailKey ?? null;
if (testFailKey !== null && !allowedFailures.has(testFailKey)) throw new Error("testFailKey must be Copper, NaturalGas, or Uranium_ETF");
return [{ json: { runKind: "manual", manual: true, testFailKey } }];`;
const KST_GUARD_CODE = String.raw`const run = $input.first().json;
const now = new Date();
const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
const minute = Number(fields.minute); const hour = Number(fields.hour); const scheduledMinute = minute < 30 ? "00" : "30";
const allowed = (minute === 0 || minute === 30) && ((fields.weekday === "Mon" && hour >= 9) || ["Tue", "Wed", "Thu", "Fri"].includes(fields.weekday) || (fields.weekday === "Sat" && (hour < 6 || (hour === 6 && minute === 0))));
if (run.runKind !== "manual" && !allowed) throw new Error("Scheduled execution is outside the approved Korea-time window");
if (run.runKind === "manual" && run.manual !== true) throw new Error("Manual execution marker is missing");
const scheduledFor = fields.year + "-" + fields.month + "-" + fields.day + "T" + String(hour).padStart(2, "0") + ":" + scheduledMinute + ":00+09:00";
return [{ json: { ...run, scheduledFor, observationId: scheduledFor, timezone: "Asia/Seoul" } }];`;
const BUILD_REQUESTS_CODE = `const run = $input.first().json;\nconst requests = ${JSON.stringify(SOURCE_REQUESTS)};\nreturn requests.map((request) => ({ json: { ...request, url: run.testFailKey === request.key ? "https://127.0.0.1.invalid/forced-failure" : request.url } }));`;
const BUILD_DRAFT_CODE = String.raw`const sources = $("Build source requests").all().map((item) => item.json); const responses = $input.all();
const asText = (value) => typeof value === "string" ? value : String(value?.body ?? value?.data ?? value?.response ?? "");
const strip = (value) => String(value ?? "").replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/\s+/gu, " ").trim();
const normalizeDramLastUpdate = ${normalizeDramLastUpdate.toString()};
const rounded = (value) => Number(Number(value).toFixed(6)); const values = { instruments: {}, macro_indicators: {}, commodities: {}, fear_greed: {}, memory: {} }; const sourceStatus = []; let currentYahooInstrumentCount = 0;
for (let index = 0; index < sources.length; index += 1) { const source = sources[index];
  try { const raw = asText(responses[index]?.json); if (!raw) throw new Error("source returned no response body");
    if (source.kind === "yahoo") { const payload = JSON.parse(raw); const chart = payload.chart?.result?.[0]; const closes = chart?.indicators?.quote?.[0]?.close ?? []; const timestamps = chart?.timestamp ?? [];
      const finite = []; for (let i = 0; i < closes.length; i += 1) if (Number.isFinite(closes[i])) finite.push({ value: Number(closes[i]), timestamp: timestamps[i] });
      if (!finite.length) throw new Error("Yahoo chart response contained no finite close"); const current = finite.at(-1); const prior = finite.length > 1 ? finite.at(-2) : null; const observedAt = Number.isFinite(current.timestamp) ? new Date(current.timestamp * 1000).toISOString() : new Date().toISOString();
      const change = prior ? rounded(current.value - prior.value) : null; const changePct = prior && prior.value !== 0 ? rounded(change / prior.value * 100) : null;
      const quote = { last: rounded(current.value), prev_close: prior ? rounded(prior.value) : null, change, change_pct: changePct, symbol: source.symbol, source: "Yahoo Finance chart API", observedAt, stale: false };
      if (source.target.startsWith("instrument")) { values.instruments[source.key] = quote; currentYahooInstrumentCount += 1; }
      if (source.target === "instrument_macro") { const macroKey = source.key === "US10Y" ? "US_10Y_Treasury" : source.key === "USDKRW" ? "KRW_USD_Exchange" : "VIX"; values.macro_indicators[macroKey] = quote.last; }
      if (source.target.startsWith("instrument_commodity:")) values.commodities[source.target.split(":")[1]] = { price: quote.last, change_pct: quote.change_pct, observedAt, stale: false };
      if (source.target === "commodity") values.commodities[source.key] = { price: quote.last, change_pct: quote.change_pct, observedAt, stale: false };
      sourceStatus.push({ key: source.key, ok: true, observedAt }); continue;
    }
    if (source.kind === "fear_greed") { const payload = JSON.parse(raw); const latest = Array.isArray(payload.data) ? payload.data[0] : null; const value = Number(latest?.value); if (!Number.isFinite(value)) throw new Error("fear/greed response contained no numeric value"); const observedAt = latest.timestamp ? new Date(Number(latest.timestamp) * 1000).toISOString() : new Date().toISOString(); values.fear_greed = { value, classification: latest.value_classification ?? null, observedAt, stale: false }; sourceStatus.push({ key: source.key, ok: true, observedAt }); continue; }
    const pageText = strip(raw); const tables = raw.match(/<table\b[\s\S]*?<\/table>/giu) ?? []; let memoryValue = null;
    for (const table of tables) for (const row of table.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? []) { const cells = Array.from(row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu), (match) => strip(match[1])); if (/^DDR5\s+16Gb\s*\(2Gx8\)\s*4800\/5600$/iu.test(cells[0] ?? "")) { const parsed = Number(String(cells[5] ?? "").replace(/[^0-9.+-]/gu, "")); if (Number.isFinite(parsed)) memoryValue = parsed; } }
    if (!Number.isFinite(memoryValue)) throw new Error("DDR5 16Gb (2Gx8) 4800/5600 Session Average was not found in the DRAM spot table"); const sourceUpdatedAt = normalizeDramLastUpdate(pageText);
    values.memory["DDR5 16Gb (2Gx8) 4800/5600"] = { value: memoryValue, sourceUpdatedAt, stale: false }; sourceStatus.push({ key: source.key, ok: true, observedAt: sourceUpdatedAt });
  } catch (error) { sourceStatus.push({ key: source.key, ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
return [{ json: { values, sourceStatus, currentYahooInstrumentCount } }];`;
const NORMALIZE_CODE = String.raw`const run = $("KST execution guard").first().json; const draft = $("Build current draft").first().json; const extracted = $("Extract previous latest").first().json; const previous = extracted?.previous?.schema === "gazua.market-pulse.v1" ? extracted.previous : null;
if (!draft.currentYahooInstrumentCount) throw new Error("No current Yahoo instrument was usable"); const values = JSON.parse(JSON.stringify(draft.values)); const carriedForward = []; const previousStatuses = new Map((previous?.sourceStatus ?? []).map((status) => [status.key, status]));
const requests = ${JSON.stringify(SOURCE_REQUESTS)}; const macroKey = (key) => key === "US10Y" ? "US_10Y_Treasury" : key === "USDKRW" ? "KRW_USD_Exchange" : "VIX";
for (const status of draft.sourceStatus) { if (status.ok || !previous) continue; const request = requests.find((item) => item.key === status.key); let copied = false;
  if (request?.target?.startsWith("instrument") && previous.values?.instruments?.[status.key]) { values.instruments[status.key] = { ...previous.values.instruments[status.key], stale: true }; copied = true; }
  if (request?.target === "instrument_macro" && Object.hasOwn(previous.values?.macro_indicators ?? {}, macroKey(status.key))) { values.macro_indicators[macroKey(status.key)] = previous.values.macro_indicators[macroKey(status.key)]; copied = true; }
  const commodityKey = request?.target === "commodity" ? status.key : request?.target?.startsWith("instrument_commodity:") ? request.target.split(":")[1] : null; if (commodityKey && previous.values?.commodities?.[commodityKey]) { values.commodities[commodityKey] = { ...previous.values.commodities[commodityKey], stale: true }; copied = true; }
  if (status.key === "fear_greed" && Object.keys(previous.values?.fear_greed ?? {}).length) { values.fear_greed = { ...previous.values.fear_greed, stale: true }; copied = true; }
  if (status.key === "ddr5" && previous.values?.memory?.["DDR5 16Gb (2Gx8) 4800/5600"]) { values.memory["DDR5 16Gb (2Gx8) 4800/5600"] = { ...previous.values.memory["DDR5 16Gb (2Gx8) 4800/5600"], stale: true }; copied = true; }
  if (copied) { carriedForward.push(status.key); status.observedAt = previousStatuses.get(status.key)?.observedAt ?? values.instruments[status.key]?.observedAt ?? values.commodities[commodityKey]?.observedAt ?? values.fear_greed?.observedAt ?? values.memory["DDR5 16Gb (2Gx8) 4800/5600"]?.sourceUpdatedAt ?? null; }
}
const observation = { schema: "gazua.market-pulse.v1", observationId: run.observationId, scheduledFor: run.scheduledFor, collectedAt: new Date().toISOString(), timezone: "Asia/Seoul", values, sourceStatus: draft.sourceStatus, carriedForward };
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value; // recursively sorted canonical JSON
const sha256Hex = ${sha256Hex.toString()};
observation.contentSha256 = sha256Hex(JSON.stringify(canonical(observation))); return [{ json: { observation, previous } }];`;
const STORAGE_PLAN_CODE = String.raw`const observation = $json.observation; const previous = $json.previous; const stamp = observation.scheduledFor.slice(0,16); const datePath = stamp.slice(0,10).replaceAll("-", "/"); const hm = stamp.slice(11,16).replace(":", ""); const sameSlot = previous?.observationId === observation.observationId; const sameHash = sameSlot && previous?.contentSha256 === observation.contentSha256; const suffix = sameSlot && !sameHash ? "-retry-" + observation.contentSha256.slice(0,12) : "";
const memoryKey = "DDR5 16Gb (2Gx8) 4800/5600"; const priorMemory = previous?.values?.memory?.[memoryKey] ?? null; const currentMemory = observation.values.memory?.[memoryKey] ?? null; const ddr5Changed = Boolean(currentMemory) && (!priorMemory || priorMemory.value !== currentMemory.value || priorMemory.sourceUpdatedAt !== currentMemory.sourceUpdatedAt);
const ddr5Event = ddr5Changed ? { schema: "gazua.ddr5-change.v1", observationId: observation.observationId, contentSha256: observation.contentSha256, previousValue: priorMemory?.value ?? null, previousSourceUpdatedAt: priorMemory?.sourceUpdatedAt ?? null, currentValue: currentMemory.value, currentSourceUpdatedAt: currentMemory.sourceUpdatedAt, detectedAt: new Date().toISOString() } : null;
return [{ json: { observation, previous, shouldWriteHistory: !sameHash, historyKey: "gazua/market-pulse/history/" + datePath + "/" + hm + suffix + ".json", latestKey: "gazua/market-pulse/latest.json", receiptKey: "gazua/market-pulse/sync-receipts/" + datePath + "/" + hm + "-" + String($execution.id) + ".json", ddr5Changed, ddr5Event, ddr5Key: "gazua/market-pulse/ddr5-changes/" + datePath + "/" + hm + "-" + observation.contentSha256.slice(0,12) + ".json" } }];`;
const binaryCode = (payload, key, fileName) => `const envelope = $input.first().json; const payload = ${payload}; return [{ json: envelope, binary: { data: { data: Buffer.from(JSON.stringify(payload, null, 2)).toString("base64"), mimeType: "application/json", fileName: "${fileName}" } } }];`;
const RECEIPT_CODE = String.raw`const observation = $("Normalize observation").first().json.observation; const storage = $("Prepare storage plan").first().json; const ingestResponse = $("Call A1 ingest").first().json ?? {}; const publicResponse = $input.first().json ?? {}; const ingestBody = ingestResponse.body ?? ingestResponse.data ?? {}; const publicBody = publicResponse.body ?? publicResponse.data ?? publicResponse; const ingestStatusCode = Number(ingestResponse.statusCode ?? ingestResponse.status ?? 0); const publicStatusCode = Number(publicResponse.statusCode ?? publicResponse.status ?? 0); const cards = Array.isArray(publicBody.cards) ? publicBody.cards : [];
const receipt = { schema: "gazua.market-pulse-sync-receipt.v1", observationId: observation.observationId, contentSha256: observation.contentSha256, n8nExecutionId: String($execution.id), attemptedAt: new Date().toISOString(), ingestStatusCode, ingestAccepted: ingestBody.accepted === true, publishedFiles: Array.isArray(ingestBody.publishedFiles) ? ingestBody.publishedFiles : [], visibleCardCount: Number(ingestBody.visibleCardCount ?? cards.length), publicStatusCode, publicCardIds: cards.map((card) => card.id).filter(Boolean), historyDisposition: storage.shouldWriteHistory ? (storage.historyKey.includes("-retry-") ? "retry" : "written") : "already-stored", historyKey: storage.historyKey, ok: ingestStatusCode >= 200 && ingestStatusCode < 300 && publicStatusCode === 200 }; return [{ json: { receipt, receiptKey: storage.receiptKey } }];`;
const ASSERT_CODE = String.raw`const receipt = $("Build sync receipt").first().json.receipt; if (!receipt.ok) throw new Error("Market-pulse synchronization failed after receipt persistence: ingest=" + receipt.ingestStatusCode + " public=" + receipt.publicStatusCode); return [{ json: receipt }];`;

function makeNode(name, type, typeVersion, parameters, position, extra = {}) {
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name, type, typeVersion, position, parameters, ...extra };
}
const codeNode = (name, code, x, y = 0) => makeNode(name, "n8n-nodes-base.code", 2, { jsCode: code }, [x, y]);
const s3Credential = (id) => ({ s3: { id, name: "papercompany-minio-n8n" } });
const uploadNode = (name, keyExpression, x, credentialId) => makeNode(name, "n8n-nodes-base.s3", 1, { operation: "upload", bucketName: "data", fileName: keyExpression, binaryPropertyName: "data", additionalFields: {} }, [x, 0], { credentials: s3Credential(credentialId) });
const ifNode = (name, expression, x) => makeNode(name, "n8n-nodes-base.if", 2.2, { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 }, conditions: [{ id: name.toLowerCase().replaceAll(" ", "-"), leftValue: expression, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }], combinator: "and" }, options: {} }, [x, 0]);
const edge = (node) => ({ node, type: "main", index: 0 });

export function buildWorkflow({ minioCredentialId, webhookCredentialId, a1CredentialId }) {
  for (const [name, value] of Object.entries({ minioCredentialId, webhookCredentialId, a1CredentialId })) if (!String(value ?? "").trim()) throw new Error(name + " is required");
  const nodes = [
    makeNode("KST Schedule", "n8n-nodes-base.scheduleTrigger", 1.2, { rule: { interval: KST_CRON_EXPRESSIONS.map((expression) => ({ field: "cronExpression", expression })) } }, [-1300, -180]),
    codeNode("Mark scheduled run", MARK_SCHEDULED_CODE, -1100, -180),
    makeNode("Manual Test Webhook", "n8n-nodes-base.webhook", 2.1, { httpMethod: "POST", path: "papercompany/gazua-market-pulse-30m", authentication: "headerAuth", responseMode: "lastNode", options: { rawBody: false } }, [-1300, 180], { credentials: { httpHeaderAuth: { id: webhookCredentialId, name: "papercompany-gazua-webhook" } } }),
    codeNode("Mark manual run", MARK_MANUAL_CODE, -1100, 180), codeNode("KST execution guard", KST_GUARD_CODE, -880), codeNode("Build source requests", BUILD_REQUESTS_CODE, -660),
    makeNode("Fetch market sources", "n8n-nodes-base.httpRequest", 4.3, { url: "={{ $json.url }}", sendHeaders: true, headerParameters: { parameters: [{ name: "Accept", value: "application/json,text/html,application/xhtml+xml,text/plain,*/*" }, { name: "Referer", value: "={{ $json.kind === 'ddr5' ? 'https://www.dramexchange.com/' : 'https://finance.yahoo.com/' }}" }, { name: "User-Agent", value: "Mozilla/5.0 (compatible; GazuaN8nMarketPulse/1.0)" }] }, options: { batching: { batch: { batchSize: 1, batchInterval: 1500 } }, timeout: 30_000, response: { response: { neverError: true, responseFormat: "text" } } } }, [-440, 0], { onError: "continueRegularOutput" }),
    codeNode("Build current draft", BUILD_DRAFT_CODE, -220),
    makeNode("Download previous latest", "n8n-nodes-base.s3", 1, { resource: "file", operation: "download", bucketName: "data", fileKey: "gazua/market-pulse/latest.json", binaryPropertyName: "data" }, [0, 0], { credentials: s3Credential(minioCredentialId), onError: "continueRegularOutput" }),
    makeNode("Extract previous latest", "n8n-nodes-base.extractFromFile", 1.1, { operation: "fromJson", binaryPropertyName: "data", destinationKey: "previous", options: { keepSource: "json" } }, [220, 0], { onError: "continueRegularOutput" }),
    codeNode("Normalize observation", NORMALIZE_CODE, 440), codeNode("Prepare storage plan", STORAGE_PLAN_CODE, 660), ifNode("Should write history?", "={{ $('Prepare storage plan').first().json.shouldWriteHistory }}", 1540),
    codeNode("Prepare history binary", binaryCode("$(\"Prepare storage plan\").first().json.observation", "envelope.historyKey", "market-pulse-history.json"), 1760, -100), uploadNode("Store history", "={{ $('Prepare storage plan').first().json.historyKey }}", 1980, minioCredentialId),
    codeNode("Prepare latest binary", binaryCode("$(\"Prepare storage plan\").first().json.observation", "envelope.latestKey", "market-pulse-latest.json"), 2200), uploadNode("Update latest", "={{ $('Prepare storage plan').first().json.latestKey }}", 2420, minioCredentialId),
    makeNode("Call A1 ingest", "n8n-nodes-base.httpRequest", 4.3, { method: "POST", url: "https://gazua.showk.ing/api/internal/market-pulse/ingest", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", sendBody: true, specifyBody: "json", jsonBody: "={{ $('Normalize observation').first().json.observation }}", options: { timeout: 30_000, response: { response: { fullResponse: true, neverError: true, responseFormat: "json" } } } }, [2640, 0], { credentials: { httpHeaderAuth: { id: a1CredentialId, name: "gazua-a1-market-pulse-ingest" } }, onError: "continueRegularOutput" }),
    makeNode("Verify public market pulse", "n8n-nodes-base.httpRequest", 4.3, { url: "https://gazua.showk.ing/api/market-pulse", options: { timeout: 30_000, response: { response: { fullResponse: true, neverError: true, responseFormat: "json" } } } }, [2860, 0], { onError: "continueRegularOutput" }),
    codeNode("Build sync receipt", RECEIPT_CODE, 3080), codeNode("Prepare receipt binary", binaryCode("envelope.receipt", "envelope.receiptKey", "market-pulse-sync-receipt.json"), 3300), uploadNode("Store sync receipt", "={{ $json.receiptKey }}", 3520, minioCredentialId), codeNode("Assert synchronization", ASSERT_CODE, 3740),
    ifNode("DDR5 changed?", "={{ $json.ddr5Changed }}", 880), codeNode("Prepare DDR5 change binary", binaryCode("envelope.ddr5Event", "envelope.ddr5Key", "ddr5-change.json"), 1100, -100), uploadNode("Store DDR5 change event", "={{ $('Prepare storage plan').first().json.ddr5Key }}", 1320, minioCredentialId),
  ];
  const connections = {
    "KST Schedule": { main: [[edge("Mark scheduled run")]] }, "Mark scheduled run": { main: [[edge("KST execution guard")]] }, "Manual Test Webhook": { main: [[edge("Mark manual run")]] }, "Mark manual run": { main: [[edge("KST execution guard")]] },
    "KST execution guard": { main: [[edge("Build source requests")]] }, "Build source requests": { main: [[edge("Fetch market sources")]] }, "Fetch market sources": { main: [[edge("Build current draft")]] }, "Build current draft": { main: [[edge("Download previous latest")]] }, "Download previous latest": { main: [[edge("Extract previous latest")]] }, "Extract previous latest": { main: [[edge("Normalize observation")]] }, "Normalize observation": { main: [[edge("Prepare storage plan")]] }, "Prepare storage plan": { main: [[edge("DDR5 changed?")]] },
    "DDR5 changed?": { main: [[edge("Prepare DDR5 change binary")], [edge("Should write history?")]] }, "Prepare DDR5 change binary": { main: [[edge("Store DDR5 change event")]] }, "Store DDR5 change event": { main: [[edge("Should write history?")]] },
    "Should write history?": { main: [[edge("Prepare history binary")], [edge("Prepare latest binary")]] }, "Prepare history binary": { main: [[edge("Store history")]] }, "Store history": { main: [[edge("Prepare latest binary")]] }, "Prepare latest binary": { main: [[edge("Update latest")]] }, "Update latest": { main: [[edge("Call A1 ingest")]] }, "Call A1 ingest": { main: [[edge("Verify public market pulse")]] }, "Verify public market pulse": { main: [[edge("Build sync receipt")]] }, "Build sync receipt": { main: [[edge("Prepare receipt binary")]] }, "Prepare receipt binary": { main: [[edge("Store sync receipt")]] }, "Store sync receipt": { main: [[edge("Assert synchronization")]] },
  };
  return { name: "Gazua - Market Pulse 30m Collect and A1 Sync", nodes, connections, settings: { executionOrder: "v1", timezone: "Asia/Seoul", availableInMCP: false } };
}
