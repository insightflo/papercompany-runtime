#!/usr/bin/env node
// scripts/quality/evidence.mjs
//
// [purpose] Versioned evaluation and PLAN-QA evidence API client.
//   PLAN-QA: plan-qa-input --issue ID; plan-qa-read --issue ID --check ID --pointer /path;
//   plan-qa-submit --issue ID --file JSON (full schemaVersion:2 verdict/checks body).
//   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID 환경변수를 사용한다.
// [boundary] 없는 권한을 자동 설치/수정하지 않는다(401/403 즉시 실패, 재시도 없음).
//   CLI stdout 은 사람 표시용이며 어떤 제어 신호도 아니다 — 서버는 stdout 을 읽지 않는다.

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";

export function configFromEnv(env = process.env) {
  const url = env.PAPERCLIP_API_URL;
  const key = env.PAPERCLIP_API_KEY;
  const runId = env.PAPERCLIP_RUN_ID;
  for (const [name, value] of [["PAPERCLIP_API_URL", url], ["PAPERCLIP_API_KEY", key], ["PAPERCLIP_RUN_ID", runId]]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new UsageError(`missing required environment variable ${name}`);
    }
  }
  return { url: url.replace(/\/+$/, ""), key, runId };
}

export class UsageError extends Error {}
export class ApiError extends Error {
  constructor(status, body) {
    super(`api_error_${status}`);
    this.status = status;
    this.body = body;
  }
}

async function post(config, path, body, method = "POST") {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      "authorization": `Bearer ${config.key}`,
      "x-paperclip-run-id": config.runId,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

const evalBase = (issueId, evaluationId) => `/api/issues/${issueId}/quality/evaluations/${evaluationId}/v1`;

export async function openCase(config, input) {
  const { data } = await post(config, `${evalBase(input.issueId, input.evaluationId)}/cases/${input.caseId}/${input.variant}/open`, {});
  return data;
}

export async function readCheck(config, input) {
  const { data } = await post(config, `${evalBase(input.issueId, input.evaluationId)}/invocations/${input.invocationId}/read`, {
    checkId: input.checkId, pointers: input.pointers,
  });
  return data;
}

export async function submitResults(config, input) {
  const { data } = await post(config, `${evalBase(input.issueId, input.evaluationId)}/invocations/${input.invocationId}/results`, {
    schemaVersion: input.schemaVersion, results: input.results,
  });
  return data;
}

export async function verifyEvaluation(config, input) {
  const { data } = await post(config, `${evalBase(input.issueId, input.evaluationId)}/verify`, {});
  return data;
}

export async function submitCandidate(config, input) {
  const { data } = await post(config, `/api/issues/${input.issueId}/quality/candidates`, {
    schemaVersion: input.schemaVersion, checks: input.checks,
  });
  return data;
}

const planQaBase = (issueId) => `/api/issues/${encodeURIComponent(issueId)}/mission-plan-qa`;

export async function planQaInput(config, input) {
  const { data } = await post(config, `${planQaBase(input.issueId)}/input`, undefined, "GET");
  return data;
}

export async function planQaRead(config, input) {
  const { data } = await post(config, `${planQaBase(input.issueId)}/read`, {
    checkId: input.checkId, pointers: input.pointers,
  });
  return data;
}

export async function planQaSubmit(config, input) {
  if (input.submission?.schemaVersion !== 2) throw new UsageError("PLAN-QA submission requires schemaVersion: 2");
  // Keep the whole versioned body: server strict validation rejects extra/scope fields.
  return post(config, `${planQaBase(input.issueId)}/verdict`, input.submission);
}

function parseCommonOptions(args) {
  const { values } = parseArgs({
    args, options: {
      issue: { type: "string" },
      evaluation: { type: "string" },
      invocation: { type: "string" },
      case: { type: "string" },
      variant: { type: "string" },
      check: { type: "string" },
      pointer: { type: "string", multiple: true },
      results: { type: "string" },
      file: { type: "string" },
    }, strict: true,
  });
  return values;
}

/** CLI 진입점. 종료 코드: 0 성공, 1 사용/API 오류, 2 구조적 MissingEvidence(재제출 필요). */
export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  let config;
  try {
    config = configFromEnv(env);
    const options = parseCommonOptions(rest);
    requireOptions(command, options);
    let output;
    switch (command) {
      case "plan-qa-input":
        output = await planQaInput(config, { issueId: options.issue });
        break;
      case "plan-qa-read":
        output = await planQaRead(config, { issueId: options.issue, checkId: options.check, pointers: options.pointer });
        break;
      case "plan-qa-submit":
        output = await planQaSubmit(config, { issueId: options.issue, submission: JSON.parse(await readFile(options.file, "utf8")) });
        break;
      case "open":
        output = await openCase(config, {
          issueId: options.issue, evaluationId: options.evaluation,
          caseId: options.case, variant: options.variant,
        });
        break;
      case "read":
        output = await readCheck(config, {
          issueId: options.issue, evaluationId: options.evaluation,
          invocationId: options.invocation, checkId: options.check, pointers: options.pointer ?? [],
        });
        break;
      case "submit": {
        const results = JSON.parse(await readFile(options.results, "utf8"));
        output = await submitResults(config, {
          issueId: options.issue, evaluationId: options.evaluation,
          invocationId: options.invocation, schemaVersion: 1, results,
        });
        break;
      }
      case "verify":
        output = await verifyEvaluation(config, { issueId: options.issue, evaluationId: options.evaluation });
        break;
      case "candidate": {
        const file = JSON.parse(await readFile(options.file, "utf8"));
        output = await submitCandidate(config, {
          issueId: options.issue, schemaVersion: 1, checks: file.checks ?? [],
        });
        break;
      }
      default:
        throw new UsageError(`unknown command: ${command ?? "(none)"}`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output?.status === "missing_evidence" ? 2 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage error: ${error.message}\n`);
      return 1;
    }
    if (error instanceof ApiError) {
      // 권한 없음(401/403) 은 자동 설치·수정·재시도 없이 즉시 실패한다.
      process.stdout.write(`${JSON.stringify({ error: error.message, status: error.status, body: error.body }, null, 2)}\n`);
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function requireOptions(command, options) {
  const need = {
    open: ["issue", "evaluation", "case", "variant"],
    read: ["issue", "evaluation", "invocation", "check", "pointer"],
    submit: ["issue", "evaluation", "invocation", "results"],
    verify: ["issue", "evaluation"],
    candidate: ["issue", "file"],
    "plan-qa-input": ["issue"],
    "plan-qa-read": ["issue", "check", "pointer"],
    "plan-qa-submit": ["issue", "file"],
  }[command] ?? [];
  for (const name of need) {
    if (options[name] === undefined || (Array.isArray(options[name]) && options[name].length === 0)) {
      throw new UsageError(`missing required option --${name} for ${command}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
