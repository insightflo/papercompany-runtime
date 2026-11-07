import { describe, expect, it } from "vitest";
import { prettyFactory } from "pino-pretty";
import { httpLogIgnore } from "../middleware/http-log-fields.js";

/**
 * pino-http emits a `responseTime` field when a request finishes. The access-log
 * transport hides the fields listed in httpLogIgnore, so a regression there makes
 * latency reports impossible to confirm after the fact (2026-11-07 A1 missions
 * investigation). These tests render the real record shape through the same
 * pino-pretty options the server uses.
 */
const httpRecord = {
  level: 30,
  time: 1_762_491_200_000,
  pid: 1234,
  hostname: "a1",
  req: { method: "GET", url: "/api/companies/c1/missions" },
  res: { statusCode: 200 },
  responseTime: 42,
  msg: "GET /api/companies/c1/missions 200",
};

function render(ignore: string): string {
  return prettyFactory({
    translateTime: "HH:MM:ss",
    ignore,
    singleLine: true,
    colorize: false,
  })(httpRecord);
}

describe("http access log fields", () => {
  it("keeps responseTime out of the ignore list", () => {
    expect(httpLogIgnore.split(",").map((field) => field.trim())).not.toContain("responseTime");
  });

  it("renders responseTime for a finished request", () => {
    expect(render(httpLogIgnore)).toContain('"responseTime":42');
  });

  it("still hides request and response bodies", () => {
    const line = render(httpLogIgnore);
    expect(line).not.toContain("/api/companies/c1/missions\"");
    expect(line).not.toContain("statusCode");
  });

  it("guards the assertion above: the same record drops responseTime when ignored", () => {
    expect(render(`${httpLogIgnore},responseTime`)).not.toContain("responseTime");
  });
});
