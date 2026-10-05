import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { L, useCompanyLanguage } from "../lib/companyLanguage";

type Option = OperatorDecisionView["definition"]["options"][number];
type Fact = Option["facts"][number];
function sameFact(left: Fact, right: Fact) {
  return left.label === right.label && left.value === right.value && left.status === right.status;
}

export function commonDecisionFacts(options: Option[]): Fact[] {
  if (options.length < 2) return [];
  return options[0].facts.filter((fact, index, facts) =>
    facts.findIndex((candidate) => sameFact(candidate, fact)) === index &&
    options.every((option) => option.facts.some((candidate) => sameFact(candidate, fact))));
}

export function uniqueDecisionFacts(facts: Fact[], common: Fact[]): Fact[] {
  return facts.filter((fact) => !common.some((candidate) => sameFact(candidate, fact)));
}

function safePreview(value: string) {
  const end = /[\uD800-\uDBFF]/.test(value[119] ?? "") && /[\uDC00-\uDFFF]/.test(value[120] ?? "") ? 119 : 120;
  return value.slice(0, end);
}

export function OperatorDecisionFacts({ facts }: { facts: Fact[] }) {
  const lang = useCompanyLanguage();
  if (facts.length === 0) return null;
  return <dl className="mt-2 grid gap-1 text-xs">{facts.map((fact, index) => (
    <div key={`${fact.label}:${fact.value}:${index}`} className="flex gap-2">
      <dt>{fact.label}</dt><dd>
        {fact.value.length > 200
          ? <details><summary>{safePreview(fact.value)}…</summary><p className="whitespace-pre-wrap">{fact.value}</p></details>
          : fact.value}
        {fact.status === "unknown" && <span className="ml-1 rounded bg-muted px-1.5 py-0.5">{L(lang, { en: "Unverified", ko: "미확인" })}</span>}
      </dd>
    </div>
  ))}</dl>;
}
