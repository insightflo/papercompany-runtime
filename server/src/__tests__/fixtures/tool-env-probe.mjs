import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_LAUNCH_MARKER, "launched");
// Only boolean checks are returned; never emit environment values.
console.log(JSON.stringify({
  resolved: process.env.CLOUDFLARE_API_KEY === "synthetic-tool-token",
  legacy: process.env.LEGACY_TEXT === "unchanged legacy text",
  plain: process.env.PLAIN_TEXT === "explicit plain text",
  masterKeyAbsent: !("PAPERCLIP_SECRETS_MASTER_KEY" in process.env),
  masterFileAbsent: !("PAPERCLIP_SECRETS_MASTER_KEY_FILE" in process.env),
  stepPrecedence: process.env.STEP_VALUE === "step",
}));
