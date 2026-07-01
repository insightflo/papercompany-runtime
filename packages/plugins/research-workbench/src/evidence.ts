import type {
  BuildEvidenceBundleInput,
  DateCoverage,
  EvidenceBundle,
  SourceType,
  VaneHeadlessSearchResult,
} from "./types.js";

const DISCUSSION_DOMAINS = [
  "reddit.com",
  "news.ycombinator.com",
  "ycombinator.com",
  "hn.algolia.com",
  "stackoverflow.com",
  "stackexchange.com",
  "discourse.org",
];

const OFFICIAL_DOC_HOST_PARTS = ["docs.", "developer.", "developers.", "learn."];
const PAPER_PATH_RE = /\b(paper|papers|publication|publications|proceedings|journal|article|abstract|pdf|research)\b/i;

export function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";

    for (const param of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(param)) {
        parsed.searchParams.delete(param);
      }
    }

    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function classifySourceType(url: string): SourceType {
  const domain = getDomain(url);
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "unknown";
  }

  if (domain === "github.com" || domain.endsWith(".github.com")) {
    return "github";
  }

  if (domain === "arxiv.org" || domain.endsWith(".arxiv.org") || domain === "doi.org" || domain.endsWith(".doi.org")) {
    return "paper";
  }

  if (domain.endsWith(".edu") && PAPER_PATH_RE.test(pathname)) {
    return "paper";
  }

  if (DISCUSSION_DOMAINS.some((discussionDomain) => domain === discussionDomain || domain.endsWith(`.${discussionDomain}`))) {
    return "discussion";
  }

  if (isHighConfidenceOfficialDocs(domain, pathname)) {
    return "official_doc";
  }

  return "web";
}

function isHighConfidenceOfficialDocs(domain: string, pathname: string): boolean {
  if (OFFICIAL_DOC_HOST_PARTS.some((part) => domain.startsWith(part))) {
    return true;
  }

  if (/\b(docs|documentation|developer|developers|api-reference|reference)\b/i.test(pathname)) {
    return true;
  }

  return false;
}

export function computeDateCoverage(results: readonly Pick<VaneHeadlessSearchResult, "publishedAt">[]): DateCoverage {
  if (results.length === 0) {
    return "unknown";
  }

  const dated = results.filter((result) => Boolean(result.publishedAt)).length;
  if (dated === 0) {
    return "unknown";
  }

  return dated / results.length >= 0.7 ? "good" : "sparse";
}

export function buildEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
  const warnings = [...(input.warnings ?? [])];
  const gaps: string[] = [];
  const seen = new Set<string>();
  const sources: EvidenceBundle["sources"] = [];
  const uniqueRawResults: VaneHeadlessSearchResult[] = [];
  let duplicateUrlsRemoved = 0;

  for (const result of input.rawResults) {
    const normalizedUrl = normalizeUrlForDedupe(result.url);
    if (seen.has(normalizedUrl)) {
      duplicateUrlsRemoved += 1;
      continue;
    }
    seen.add(normalizedUrl);
    uniqueRawResults.push(result);

    sources.push({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      sourceType: classifySourceType(result.url),
      retrievedAt: input.retrievedAt,
    });
  }

  appendUnsupportedInputWarnings(input, warnings);

  if (sources.length < input.profile.minSources) {
    const gap = `profile requires ${input.profile.minSources} sources, only ${sources.length} found`;
    warnings.push(gap);
    gaps.push(gap);
  }

  const uniqueDomains = new Set(sources.map((source) => getDomain(source.url)).filter(Boolean)).size;

  return {
    topic: input.topic ?? input.input.query,
    query: input.input.query,
    profile: input.profile.name,
    sources,
    warnings,
    gaps,
    qa: {
      sourceCount: sources.length,
      minSources: input.profile.minSources,
      passedMinSources: sources.length >= input.profile.minSources,
      duplicateUrlsRemoved,
      uniqueDomains,
      dateCoverage: computeDateCoverage(uniqueRawResults),
    },
    rawEngine: input.rawEngine,
  };
}

function appendUnsupportedInputWarnings(input: BuildEvidenceBundleInput, warnings: string[]): void {
  if (input.input.domainHints && input.input.domainHints.length > 0) {
    warnings.push("domainHints are accepted for contract compatibility but are not enforced in MVP-B");
  }

  if (input.input.excludeDomains && input.input.excludeDomains.length > 0) {
    warnings.push("excludeDomains are accepted for contract compatibility but are not enforced in MVP-B");
  }

  if (input.input.freshness === "recent_required") {
    warnings.push("strict freshness is not enforced in MVP-B; recent_required was not applied");
  } else if (input.input.freshness === "recent_preferred") {
    warnings.push("freshness preference is not enforced in MVP-B; recent_preferred was not applied");
  }
}
