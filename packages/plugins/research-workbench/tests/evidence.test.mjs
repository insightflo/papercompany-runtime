import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceBundle,
  classifySourceType,
  computeDateCoverage,
  normalizeUrlForDedupe,
} from "../dist/evidence.js";
import { resolveResearchProfile, resolveSourceScopeCategories } from "../dist/profiles.js";

const rawEngine = {
  name: "vane-headless",
  baseUrl: "http://127.0.0.1:3300",
};

function buildBundle({ rawResults, profileInput = {}, input = {}, warnings = [] }) {
  const resolution = resolveResearchProfile(profileInput);
  return buildEvidenceBundle({
    input: { query: "papercompany research", ...profileInput, ...input },
    rawResults,
    profile: resolution.profile,
    retrievedAt: "2026-05-28T00:00:00.000Z",
    rawEngine,
    warnings: [...resolution.warnings, ...warnings],
  });
}

test("duplicate URLs are removed by normalized URL", () => {
  assert.equal(
    normalizeUrlForDedupe("https://www.example.com/path/?utm_source=x#section"),
    "https://example.com/path",
  );

  const bundle = buildBundle({
    rawResults: [
      { title: "A", url: "https://www.example.com/path/?utm_source=x#top", snippet: "first" },
      { title: "B", url: "https://example.com/path", snippet: "duplicate" },
      { title: "C", url: "https://other.example/resource", snippet: "other" },
      { title: "D", url: "https://third.example/resource", snippet: "third" },
    ],
  });

  assert.equal(bundle.sources.length, 3);
  assert.equal(bundle.qa.duplicateUrlsRemoved, 1);
  assert.deepEqual(
    bundle.sources.map((source) => source.title),
    ["A", "C", "D"],
  );
});

test("minSources warning and gap are emitted", () => {
  const bundle = buildBundle({
    profileInput: { profile: "tech_scout" },
    rawResults: [
      { title: "GitHub", url: "https://github.com/owner/repo", snippet: "repo" },
      { title: "Docs", url: "https://docs.example.com/guide", snippet: "docs" },
      { title: "Web", url: "https://example.net/post", snippet: "web" },
    ],
  });

  assert.equal(bundle.profile, "tech_scout");
  assert.equal(bundle.qa.minSources, 5);
  assert.equal(bundle.qa.sourceCount, 3);
  assert.equal(bundle.qa.passedMinSources, false);
  assert.match(bundle.warnings.join("\n"), /profile requires 5 sources, only 3 found/);
  assert.deepEqual(bundle.gaps, ["profile requires 5 sources, only 3 found"]);
});

test("uniqueDomains and dateCoverage are computed", () => {
  const sparse = buildBundle({
    rawResults: [
      { title: "A", url: "https://a.example/1", snippet: "a", publishedAt: "2026-05-01" },
      { title: "B", url: "https://b.example/1", snippet: "b" },
      { title: "C", url: "https://b.example/2", snippet: "c" },
    ],
  });

  assert.equal(sparse.qa.uniqueDomains, 2);
  assert.equal(sparse.qa.dateCoverage, "sparse");
  assert.equal(computeDateCoverage([]), "unknown");
  assert.equal(
    computeDateCoverage([
      { publishedAt: "2026-05-01" },
      { publishedAt: "2026-05-02" },
      { publishedAt: "2026-05-03" },
      { publishedAt: undefined },
    ]),
    "good",
  );
});

test("github, arxiv, doi, edu paper paths, and discussion source types are classified conservatively", () => {
  assert.equal(classifySourceType("https://github.com/ItzCrazyKns/Vane"), "github");
  assert.equal(classifySourceType("https://arxiv.org/abs/2401.00001"), "paper");
  assert.equal(classifySourceType("https://doi.org/10.1000/example"), "paper");
  assert.equal(classifySourceType("https://cs.example.edu/publications/paper.pdf"), "paper");
  assert.equal(classifySourceType("https://www.reddit.com/r/MachineLearning/comments/abc"), "discussion");
  assert.equal(classifySourceType("https://news.ycombinator.com/item?id=1"), "discussion");
  assert.equal(classifySourceType("https://docs.example.com/reference"), "official_doc");
  assert.equal(classifySourceType("https://example.com/blog/post"), "web");
});

test("unsupported filters, future profiles, and reserved source scopes become warnings instead of fake enforcement", () => {
  const profileResolution = resolveResearchProfile({ profile: "academic" });
  assert.equal(profileResolution.profile.name, "general");
  assert.match(profileResolution.warnings.join("\n"), /reserved.*falling back to general/);

  const futureProfileResolution = resolveResearchProfile({ futureProfile: "market", profile: "tech_scout" });
  assert.equal(futureProfileResolution.profile.name, "tech_scout");
  assert.match(futureProfileResolution.warnings.join("\n"), /market.*reserved/);
  assert.match(futureProfileResolution.warnings.join("\n"), /explicitly requested tech_scout/);

  const unsupportedDiscussions = resolveSourceScopeCategories(["web", "discussions"], {
    discussionsSupported: false,
  });
  assert.deepEqual(unsupportedDiscussions.categories, ["general"]);
  assert.match(unsupportedDiscussions.warnings.join("\n"), /discussions.*not declared as supported/);

  const supportedDiscussions = resolveSourceScopeCategories(["discussions"], { discussionsSupported: true });
  assert.deepEqual(supportedDiscussions.categories, ["social media"]);

  const academicScope = resolveSourceScopeCategories(["academic"]);
  assert.deepEqual(academicScope.categories, ["general"]);
  assert.match(academicScope.warnings.join("\n"), /academic.*reserved/);
  assert.match(academicScope.warnings.join("\n"), /academic search was not performed/);

  const bundle = buildBundle({
    profileInput: { profile: "academic" },
    input: {
      domainHints: ["example.com"],
      excludeDomains: ["blocked.example"],
      freshness: "recent_required",
    },
    rawResults: [
      { title: "A", url: "https://a.example/1", snippet: "a" },
      { title: "B", url: "https://b.example/1", snippet: "b" },
      { title: "C", url: "https://c.example/1", snippet: "c" },
    ],
  });

  assert.equal(bundle.profile, "general");
  assert.match(bundle.warnings.join("\n"), /domainHints.*not enforced/);
  assert.match(bundle.warnings.join("\n"), /excludeDomains.*not enforced/);
  assert.match(bundle.warnings.join("\n"), /strict freshness.*not enforced/);
});
