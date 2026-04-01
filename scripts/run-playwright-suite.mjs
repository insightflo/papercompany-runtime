#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  getPlaywrightSuiteConfigCandidates,
  normalizeForwardedPlaywrightArgs,
  resolvePlaywrightSuiteExecutionContext,
} from "./playwright-suite-config.mjs";

const [suiteName, ...rawForwardedArgs] = process.argv.slice(2);

if (!suiteName) {
  console.error("Missing required suite name. Usage: node scripts/run-playwright-suite.mjs <suite>");
  process.exit(1);
}

const executionContext = resolvePlaywrightSuiteExecutionContext({ suiteName });

if (!executionContext) {
  const candidateList = getPlaywrightSuiteConfigCandidates(suiteName)
    .map((candidate) => `- ${candidate}`)
    .join("\n");
  console.error(`Unable to find Playwright config for suite "${suiteName}". Checked:\n${candidateList}`);
  process.exit(1);
}

const forwardedArgs = normalizeForwardedPlaywrightArgs(rawForwardedArgs);
const child = spawn("npx", ["playwright", "test", "--config", executionContext.configArg, ...forwardedArgs], {
  stdio: "inherit",
  env: process.env,
  cwd: executionContext.commandCwd,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
