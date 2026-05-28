import assert from "node:assert/strict";
import test from "node:test";

import { buildIssueHref } from "../dist/ui/routes.js";

test("buildIssueHref uses the issue prefix instead of the company UUID route", () => {
  assert.equal(
    buildIssueHref({
      issueId: "2f2119a4-40ac-4f0d-9d25-b75afccee546",
      issueIdentifier: "CMPA-1277",
      currentPathname: "/CMPA/workflows",
    }),
    "/CMPA/issues/2f2119a4-40ac-4f0d-9d25-b75afccee546",
  );
});

test("buildIssueHref falls back to the current company prefix on workflow pages", () => {
  assert.equal(
    buildIssueHref({
      issueId: "issue-id",
      currentPathname: "/CMPAA/workflows",
    }),
    "/CMPAA/issues/issue-id",
  );
});

test("buildIssueHref never emits legacy /c/<companyId>/issues links", () => {
  const href = buildIssueHref({
    issueId: "2f2119a4-40ac-4f0d-9d25-b75afccee546",
    issueIdentifier: "CMPA-1277",
    currentPathname: "/CMPA/workflows",
  });
  assert.equal(href.startsWith("/c/"), false);
});
