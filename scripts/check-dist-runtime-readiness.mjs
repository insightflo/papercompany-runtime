#!/usr/bin/env node
/**
 * check-dist-runtime-readiness.mjs
 *
 * [dist 기동 차단 요인 회귀 가드] `node dist` 경로로 서버를 띄우는 A1 전환의
 * 리포 측 선행 조건(B1 exports 조건, B2 db 마이그레이션 산출물, 낡은 dist 잔존)을
 * 검증하는 수동 실행 검사. 근거: reboot-1107/a1-opt-plan.md §2.1-§2.3.
 *
 * 하위 검사:
 *   exports — 13개 워크스페이스 패키지 package.json 의 exports 에
 *             "paperclip-dist" 조건이 존재하고 dist 대상 파일이 실재하는지.
 *   journal — packages/db/dist/migrations/meta/_journal.json 의 entries 수가
 *             src/migrations 저널과 같은지 + 중첩 복사(migrations/migrations)
 *             부재. preflight 수동 명령(동등):
 *               node -e 'const f=p=>JSON.parse(require("fs").readFileSync(p,"utf8")).entries.length;process.exit(f("packages/db/dist/migrations/meta/_journal.json")===f("packages/db/src/migrations/meta/_journal.json")?0:1)'
 *   clean   — server/dist 에 가짜 잔존 파일을 심은 뒤 server build 를 돌려
 *             제거됨을 확인하고, dist 안의 모든 .js 가 src 안의 동일 상대경로
 *             .ts|.tsx 와 1:1 대응함을 감사한다(소스 없는 잔존 = FAIL).
 *   start   — `node --conditions=paperclip-dist dist/index.js` 를 server/ 에서
 *             띄워 모듈 해석을 통과하고 기동 전 단계(preflight·기동 로그)까지
 *             도달하는지 관찰한다. 기동 완료·타임아웃 생존도 PASS.
 *
 * 사용:
 *   node scripts/check-dist-runtime-readiness.mjs            # all
 *   node scripts/check-dist-runtime-readiness.mjs exports|journal|clean|start
 *   node scripts/check-dist-runtime-readiness.mjs start --timeout=60000
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_DIR = join(ROOT, "packages/db");
const SERVER_DIR = join(ROOT, "server");

const CONDITION_PACKAGES = [
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/antigravity-local",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/commandcode-local",
  "packages/adapters/cursor-local",
  "packages/adapters/gemini-local",
  "packages/adapters/openclaw-gateway",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
  "packages/plugins/sdk",
];

const MODULE_ERROR_PATTERN =
  /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_PACKAGE_IMPORT_NOT_DEFINED|ERR_UNKNOWN_FILE_EXTENSION|is not exported by/;

const STARTUP_MARKERS = [
  "Paperclip",
  "Embedded PostgreSQL",
  "embedded-postgres",
  "Migrations",
  "Server listening",
  "loadConfig",
  "database",
];

const results = [];
function report(name, ok, detail) {
  results.push([name, ok]);
  console.log(`[dist-readiness] ${name} ${ok ? "PASS" : "FAIL"}${detail ? ` — ${detail}` : ""}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function checkExports() {
  const missing = [];
  for (const dir of CONDITION_PACKAGES) {
    const pkg = readJson(join(ROOT, dir, "package.json"));
    const entries = Object.entries(pkg.exports ?? {});
    if (entries.length === 0) missing.push(`${dir}: exports 없음`);
    for (const [sub, val] of entries) {
      const target = typeof val === "object" && val !== null ? val["paperclip-dist"] : null;
      if (!target) {
        missing.push(`${dir} ${sub}: paperclip-dist 조건 없음`);
        continue;
      }
      if (target.includes("*")) {
        const baseDir = join(ROOT, dir, target.slice(0, target.indexOf("*")));
        const hasAny =
          existsSync(baseDir) &&
          readdirSync(baseDir, { recursive: true }).some((f) => String(f).endsWith(".js"));
        if (!hasAny) missing.push(`${dir} ${sub}: 대상 ${target} 매칭 파일 없음(build 필요?)`);
      } else if (!existsSync(join(ROOT, dir, target))) {
        missing.push(`${dir} ${sub}: 대상 ${target} 미존재(build 필요?)`);
      }
    }
  }
  report("exports", missing.length === 0, missing.join("; ") || `${CONDITION_PACKAGES.length}개 패키지 조건·대상 확인`);
}

function checkJournal() {
  const src = readJson(join(DB_DIR, "src/migrations/meta/_journal.json")).entries.length;
  const distPath = join(DB_DIR, "dist/migrations/meta/_journal.json");
  const problems = [];
  let dist = 0;
  if (!existsSync(distPath)) {
    problems.push("dist 저널 없음(build 필요)");
  } else {
    dist = readJson(distPath).entries.length;
    if (dist !== src) problems.push(`journal entries: dist=${dist} != src=${src}`);
  }
  if (existsSync(join(DB_DIR, "dist/migrations/migrations"))) {
    problems.push("중첩 복사 dist/migrations/migrations 존재");
  }
  report("journal", problems.length === 0, problems.join("; ") || `entries dist=${dist} == src=${src}`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function checkClean() {
  const marker = join(SERVER_DIR, "dist/adapters/__dist_check_stale__.js");
  mkdirSync(join(SERVER_DIR, "dist/adapters"), { recursive: true });
  writeFileSync(marker, "// stale artifact probe\n");
  const build = spawnSync("pnpm", ["--filter", "@paperclipai/server", "build"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (build.status !== 0) {
    report("clean", false, `server build 실패: ${(build.stderr || build.stdout || "").slice(-400)}`);
    return;
  }
  const problems = [];
  if (existsSync(marker)) problems.push("심은 잔존 파일이 재빌드 후에도 남음");
  const orphans = [];
  for (const file of walk(join(SERVER_DIR, "dist"))) {
    if (!file.endsWith(".js")) continue;
    const rel = relative(join(SERVER_DIR, "dist"), file).replace(/\.js$/, "");
    if (
      !existsSync(join(SERVER_DIR, "src", `${rel}.ts`)) &&
      !existsSync(join(SERVER_DIR, "src", `${rel}.tsx`))
    ) {
      orphans.push(rel);
    }
  }
  if (orphans.length > 0) problems.push(`소스 없는 잔존 .js ${orphans.length}건: ${orphans.slice(0, 5).join(", ")}`);
  report("clean", problems.length === 0, problems.join("; ") || "잔존 시드 제거 + dist↔src 매핑 0건 이탈");
}

function checkStart(timeoutMs) {
  if (!existsSync(join(SERVER_DIR, "dist/index.js"))) {
    report("start", false, "server/dist/index.js 없음 — pnpm -r build 먼저");
    return;
  }
  const child = spawn(process.execPath, ["--conditions=paperclip-dist", "dist/index.js"], {
    cwd: SERVER_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      resolve({ kind: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ kind: "exit", code, signal });
    });
  });
  return done.then((result) => {
    const tail = out.trim().split("\n").slice(-8).join("\n");
    if (MODULE_ERROR_PATTERN.test(out)) {
      console.log(tail);
      report("start", false, "모듈 해석 단계에서 실패(위 출력)");
      return;
    }
    const marker = STARTUP_MARKERS.find((m) => out.includes(m));
    const reached = marker ?? "출력 없음";
    if (result.kind === "timeout") {
      report("start", true, `${timeoutMs / 1000}s 생존 후 종료 — 기동 단계 도달(마커: ${reached})`);
      return;
    }
    if (result.code === 0) {
      report("start", true, `정상 종료(exit 0, 마커: ${reached})`);
      return;
    }
    // 모듈 해석 이후 단계에서의 종료는 B1 해소 증거로는 유효하지만 사유를 보여야 한다.
    console.log(tail);
    report("start", marker !== undefined, `기동 단계 종료(exit ${result.code ?? result.signal}, 마커: ${reached})`);
  });
}

async function main() {
  const [cmd = "all", ...rest] = process.argv.slice(2);
  const timeoutArg = rest.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : 45_000;
  const run = (name) => cmd === "all" || cmd === name;
  if (run("exports")) checkExports();
  if (run("journal")) checkJournal();
  if (run("clean")) checkClean();
  if (run("start")) await checkStart(timeoutMs);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`[dist-readiness] ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
