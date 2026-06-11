#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ALPHA_ROOT = "/Users/kwak/Projects/ai/alpha-prime-personal";
const DEFAULT_DASHBOARD_ROOT = "/Users/kwak/Projects/ai/gazua-dashboard";

const KR_PATTERNS = [
  {
    theme: "KR 원전/전력기기",
    lead_etf: "KR-Discovered Nuclear Power Grid Basket",
    keywords: ["원전", "한전", "전력", "일렉트릭", "전기", "변압기", "전선", "송전", "배전"],
    seed_theme: "KR AI 전력인프라",
  },
  {
    theme: "KR 바이오/헬스케어",
    lead_etf: "KR-Discovered Bio Healthcare Basket",
    keywords: ["바이오", "제약", "헬스", "메디", "셀트리온", "삼성바이오", "유한", "한미약품"],
  },
  {
    theme: "KR 이차전지/소재",
    lead_etf: "KR-Discovered Battery Materials Basket",
    keywords: ["배터리", "전지", "에코프로", "엘앤에프", "포스코", "소재", "양극재", "리튬"],
  },
  {
    theme: "KR 로봇/자동화",
    lead_etf: "KR-Discovered Robotics Automation Basket",
    keywords: ["로봇", "자동화", "두산로보", "레인보우", "로보", "스마트팩토리"],
  },
  {
    theme: "KR 화장품/중국소비",
    lead_etf: "KR-Discovered Cosmetics China Consumer Basket",
    keywords: ["화장품", "코스맥스", "한국콜마", "아모레", "LG생활", "클리오", "중국소비"],
  },
  {
    theme: "KR 인터넷/게임",
    lead_etf: "KR-Discovered Internet Game Basket",
    keywords: ["네이버", "카카오", "게임", "엔씨", "크래프톤", "넷마블", "위메이드"],
  },
  {
    theme: "KR 엔터/미디어",
    lead_etf: "KR-Discovered Entertainment Media Basket",
    keywords: ["엔터", "하이브", "JYP", "SM", "YG", "미디어", "스튜디오", "콘텐츠"],
  },
  {
    theme: "KR 건설/인프라",
    lead_etf: "KR-Discovered Construction Infra Basket",
    keywords: ["건설", "시멘트", "건자재", "인프라", "현대건설", "GS건설", "대우건설"],
  },
];

const US_CROSS_THEMES = [
  {
    theme: "AI 인프라/전력 수요",
    lead_etf: "US-Discovered AI Infrastructure Basket",
    anchors: ["AI/반도체", "클라우드/SW", "유틸리티", "원자재"],
    seed_theme: "AI/반도체",
  },
  {
    theme: "디지털 보안/클라우드 방어",
    lead_etf: "US-Discovered Cyber Cloud Basket",
    anchors: ["사이버보안", "클라우드/SW", "AI/반도체"],
    seed_theme: "사이버보안",
  },
  {
    theme: "금리민감 안전자산",
    lead_etf: "US-Discovered Rate Sensitive Defensive Basket",
    anchors: ["금/귀금속", "필수소비재", "유틸리티", "부동산(REIT)"],
  },
  {
    theme: "에너지/해운 병목",
    lead_etf: "US-Discovered Energy Shipping Bottleneck Basket",
    anchors: ["에너지", "해운/물류", "원자재"],
  },
  {
    theme: "헬스케어/바이오 리스크온",
    lead_etf: "US-Discovered Healthcare Bio Basket",
    anchors: ["헬스케어", "바이오"],
  },
];

function parseArgs(argv) {
  const args = {
    market: "",
    alphaRoot: DEFAULT_ALPHA_ROOT,
    dashboardRoot: DEFAULT_DASHBOARD_ROOT,
    skipBase: false,
    date: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--market") args.market = String(argv[++i] || "").toUpperCase();
    else if (arg === "--alpha-root") args.alphaRoot = String(argv[++i] || "");
    else if (arg === "--dashboard-root") args.dashboardRoot = String(argv[++i] || "");
    else if (arg === "--date") args.date = String(argv[++i] || "");
    else if (arg === "--skip-base") args.skipBase = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else fail(`Unknown argument: ${arg}`);
  }
  if (!["KR", "US"].includes(args.market)) {
    fail("--market must be KR or US");
  }
  return args;
}

function usage(code) {
  console.log(`Usage:
  node scripts/gazua-theme-discovery-wrapper.mjs --market KR [--skip-base]
  node scripts/gazua-theme-discovery-wrapper.mjs --market US [--skip-base]

Runs the existing Gazua market signal producer, then appends producer-owned
discovered theme entries while preserving the dashboard theme JSON contract.`);
  process.exit(code);
}

function fail(message) {
  console.error(`[gazua-theme-discovery] ${message}`);
  process.exit(1);
}

function runBaseProducer(args) {
  if (args.skipBase) return;
  const result = spawnSync("./venv/bin/python", ["scripts/run_market_signals.py", "--market", args.market], {
    cwd: args.alphaRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`base market signal producer failed for ${args.market} with exit code ${result.status}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload, dryRun) {
  if (dryRun) {
    console.log(`[gazua-theme-discovery] dry-run write: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function latestFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const files = fs.readdirSync(dir)
    .filter((name) => matcher.test(name))
    .map((name) => path.join(dir, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function themePath(root, market, date = "") {
  const base = path.join(root, "data", "market_signals");
  const suffix = date || "\\d{4}-\\d{2}-\\d{2}";
  if (market === "KR") {
    return date
      ? path.join(base, "KR", `theme_${date}.json`)
      : latestFile(path.join(base, "KR"), /^theme_\d{4}-\d{2}-\d{2}\.json$/);
  }
  const scoped = date
    ? path.join(base, "US", `theme_${date}.json`)
    : latestFile(path.join(base, "US"), /^theme_\d{4}-\d{2}-\d{2}\.json$/);
  if (scoped && fs.existsSync(scoped)) return scoped;
  return date
    ? path.join(base, `theme_${date}.json`)
    : latestFile(base, new RegExp(`^theme_${suffix}\\.json$`));
}

function existingThemePath(roots, market, date = "") {
  const candidates = roots
    .map((root) => themePath(root, market, date))
    .filter((candidate) => candidate && fs.existsSync(candidate));
  if (date) {
    return candidates[0] || null;
  }
  return candidates
    .sort((a, b) => {
      const dateA = themeDateFromPath(a);
      const dateB = themeDateFromPath(b);
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    })[0] || null;
}

function themeDateFromPath(filePath) {
  return path.basename(filePath).match(/^theme_(\d{4}-\d{2}-\d{2})\.json$/)?.[1] || "";
}

function normalizeFixedThemes(payload, market) {
  payload.all_themes = (payload.all_themes || []).map((item) => ({
    ...item,
    market: item.market || market,
    theme_origin: item.theme_origin || "fixed",
    name_confidence: item.name_confidence || "high",
  }));
  payload.top_bullish = (payload.top_bullish || []).map((item) => ({
    ...item,
    market: item.market || market,
    theme_origin: item.theme_origin || "fixed",
    name_confidence: item.name_confidence || "high",
  }));
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function loadLatestKrxRows(args) {
  const candidates = [
    path.join(args.dashboardRoot, "data", "metadata"),
    path.join(args.alphaRoot, "data", "metadata"),
  ];
  const csvPath = candidates
    .map((dir) => latestFile(dir, /^krx_metadata_\d{8}\.csv$/))
    .find(Boolean);
  if (!csvPath) return { rows: [], source: null };
  const lines = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rows: [], source: csvPath };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    return row;
  });
  return { rows, source: csvPath };
}

function num(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function krRowHeat(row) {
  const change = num(row.ChagesRatio);
  const amount = num(row.Amount);
  const marketCap = num(row.Marcap);
  return round(change * 0.7 + Math.min(amount / 1_000_000_000_000, 5) * 6 + Math.min(marketCap / 10_000_000_000_000, 5), 2);
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stageFromHeat(heat, direction) {
  if (direction === "bearish") return { stage: "Dead/Cooling", emoji: "cold", desc: "Discovered cluster is cooling or lacks positive breadth" };
  if (heat >= 45) return { stage: "Bottleneck", emoji: "hot", desc: "Discovered multi-anchor cluster with concentrated heat" };
  if (heat >= 25) return { stage: "Expansion", emoji: "up", desc: "Discovered multi-anchor cluster is expanding" };
  return { stage: "Whisper", emoji: "seed", desc: "Discovered multi-anchor cluster is early but visible" };
}

function discoverKrThemes(payload, args) {
  const fixedNames = new Set((payload.all_themes || []).map((item) => String(item.theme || "")));
  const { rows, source } = loadLatestKrxRows(args);
  const sourceLabel = source ? path.relative(args.dashboardRoot, source).replaceAll(path.sep, "/") : "data/metadata/krx_metadata_YYYYMMDD.csv";
  const discovered = [];

  for (const pattern of KR_PATTERNS) {
    if (fixedNames.has(pattern.theme)) continue;
    const matched = rows
      .filter((row) => {
        const name = String(row.Name || "");
        return pattern.keywords.some((keyword) => name.includes(keyword));
      })
      .map((row) => ({
        ticker: row.Code,
        name: row.Name,
        market: row.Market,
        heat: krRowHeat(row),
        change_pct: num(row.ChagesRatio),
        amount: Math.trunc(num(row.Amount)),
      }))
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.heat - a.heat);

    const unique = dedupeBy(matched, (row) => `${row.ticker}:${row.name}`).slice(0, 8);
    if (unique.length < 2) continue;
    const positive = unique.filter((row) => row.change_pct > 0).length;
    const avgHeat = round(unique.reduce((sum, row) => sum + row.heat, 0) / unique.length, 2);
    const direction = positive / unique.length >= 0.4 || avgHeat >= 20 ? "bullish" : "bearish";
    discovered.push({
      theme: pattern.theme,
      lead_etf: pattern.lead_etf,
      market: "KR",
      heat: avgHeat,
      direction,
      ret_5d: round(unique.reduce((sum, row) => sum + row.change_pct, 0) / unique.length, 2),
      ret_20d: null,
      vol_ratio: null,
      current_price: null,
      component_count: unique.length,
      components: unique.slice(0, 6),
      lifecycle: stageFromHeat(avgHeat, direction),
      theme_origin: "discovered",
      name_confidence: "medium",
      discovery_method: "krx_metadata_cluster",
      discovery_evidence: [
        `Matched ${unique.length} KRX components by ${pattern.keywords.slice(0, 5).join(", ")}`,
        `Positive breadth ${positive}/${unique.length}`,
        `Source ${sourceLabel}`,
      ],
      ...(pattern.seed_theme ? { seed_theme: pattern.seed_theme } : {}),
    });
  }

  return discovered;
}

function discoverUsThemes(payload) {
  const fixedThemes = new Map((payload.all_themes || []).map((item) => [String(item.theme || ""), item]));
  const fixedNames = new Set(fixedThemes.keys());
  const discovered = [];

  for (const rule of US_CROSS_THEMES) {
    if (fixedNames.has(rule.theme)) continue;
    const anchors = rule.anchors.map((name) => fixedThemes.get(name)).filter(Boolean);
    if (anchors.length < 2) continue;
    const bullish = anchors.filter((item) => String(item.direction || "").toLowerCase() === "bullish");
    if (bullish.length < 2) continue;
    const heat = round(anchors.reduce((sum, item) => sum + num(item.heat), 0) / anchors.length, 1);
    const ret5 = round(anchors.reduce((sum, item) => sum + num(item.ret_5d), 0) / anchors.length, 2);
    const ret20 = round(anchors.reduce((sum, item) => sum + num(item.ret_20d), 0) / anchors.length, 2);
    const direction = bullish.length / anchors.length >= 0.5 ? "bullish" : "bearish";
    discovered.push({
      theme: rule.theme,
      lead_etf: rule.lead_etf,
      market: "US",
      heat,
      direction,
      ret_5d: ret5,
      ret_20d: ret20,
      vol_ratio: null,
      current_price: null,
      component_count: anchors.length,
      components: anchors.map((item) => ({
        theme: item.theme,
        lead_etf: item.lead_etf,
        heat: item.heat,
        direction: item.direction,
        stage: item.lifecycle?.stage,
      })),
      lifecycle: stageFromHeat(heat, direction),
      theme_origin: "discovered",
      name_confidence: "medium",
      discovery_method: "cross_theme_momentum_cluster",
      discovery_evidence: [
        `Cross-theme anchors: ${anchors.map((item) => item.theme).join(", ")}`,
        `Bullish anchors ${bullish.length}/${anchors.length}`,
      ],
      ...(rule.seed_theme ? { seed_theme: rule.seed_theme } : {}),
    });
  }

  return discovered;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function mergeDiscovered(payload, market, discovered) {
  const existing = new Set((payload.all_themes || []).map((item) => String(item.theme || "")));
  const additions = discovered.filter((item) => !existing.has(String(item.theme || "")));
  payload.all_themes = [...(payload.all_themes || []), ...additions]
    .sort((a, b) => num(b.heat) - num(a.heat));
  payload.top_bullish = payload.all_themes
    .filter((item) => String(item.direction || "").toLowerCase() === "bullish")
    .slice(0, 10);
  payload.groups = payload.all_themes.slice(0, 8).map((item) => ({
    theme: item.theme,
    market,
    heat: item.heat,
    items: [item],
  }));
  payload.market = market;
  payload.generated_at = new Date().toISOString();
  payload.methodology = [
    payload.methodology || "Theme rotation signal",
    "Papercompany Gazua producer wrapper appends fixed-seed plus discovered multi-anchor theme clusters while preserving dashboard JSON contract.",
  ].join(" ");
  payload.discovery_summary = {
    generated_by: "papercompany:scripts/gazua-theme-discovery-wrapper.mjs",
    fixed_count: payload.all_themes.filter((item) => item.theme_origin !== "discovered").length,
    discovered_count: additions.length,
    discovered_themes: additions.map((item) => item.theme),
  };
  const sourceFiles = new Set(payload.source_files || []);
  sourceFiles.add("papercompany:scripts/gazua-theme-discovery-wrapper.mjs");
  payload.source_files = Array.from(sourceFiles);
  return additions;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  runBaseProducer(args);

  const sourcePath = existingThemePath([args.dashboardRoot, args.alphaRoot], args.market, args.date);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    fail(`theme artifact not found for market ${args.market}`);
  }

  const payload = readJson(sourcePath);
  normalizeFixedThemes(payload, args.market);
  const discovered = args.market === "KR"
    ? discoverKrThemes(payload, args)
    : discoverUsThemes(payload, args);
  const additions = mergeDiscovered(payload, args.market, discovered);
  const outputPath = themePath(args.dashboardRoot, args.market, payload.date);
  writeJson(outputPath, payload, args.dryRun);

  console.log(JSON.stringify({
    market: args.market,
    sourcePath,
    outputPath,
    discoveredCount: additions.length,
    discoveredThemes: additions.map((item) => item.theme),
  }, null, 2));
}

main();
