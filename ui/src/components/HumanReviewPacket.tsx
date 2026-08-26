import type { HumanReviewPacket as HumanReviewPacketValue } from "@paperclipai/shared";
import { AlertTriangle, ArrowUpRight, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { Link } from "../lib/router";

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return href.startsWith("/")
    ? <Link to={href} className="inline-flex items-center gap-1 font-medium">{children}<ArrowUpRight className="h-3 w-3" /></Link>
    : <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium">{children}<ArrowUpRight className="h-3 w-3" /></a>;
}

export function HumanReviewPacket({ packet }: { packet: HumanReviewPacketValue | null }) {
  if (!packet) return (
    <section className="mt-3 border border-amber-500/50 bg-amber-500/10 p-4" data-testid="human-review-incomplete">
      <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><div>
        <h3 className="text-sm font-semibold">판단 정보가 부족해 승인할 수 없습니다</h3>
        <p className="mt-1 text-sm text-muted-foreground">판단 주제, 근거 원본의 정확한 위치, 해석, 승인·거절·오판 영향과 다음 단계를 요청자에게 보완받아야 합니다.</p>
      </div></div>
    </section>
  );
  return (
    <section className="mt-3 space-y-4 border border-border bg-background p-4" data-testid="human-review-packet">
      <div><p className="text-xs font-semibold text-muted-foreground">무엇을 판단하나요?</p><h3 className="mt-1 text-base font-semibold">{packet.decisionSubject}</h3></div>
      <div><p className="text-xs font-semibold text-muted-foreground">현재 해석</p><p className="mt-1 whitespace-pre-line text-sm">{packet.interpretation}</p></div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">판단 근거와 원본 위치</p>
        <ul className="mt-2 space-y-2">{packet.evidence.map((item) => <li key={`${item.href}:${item.location}`} className="border-l-2 border-primary/40 pl-3 text-sm">
          <SourceLink href={item.href}>{item.label}</SourceLink><p className="mt-0.5 text-xs text-muted-foreground">원본 위치: {item.location}</p>{item.description && <p className="mt-0.5 whitespace-pre-line text-xs">{item.description}</p>}
        </li>)}</ul>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <div className="border border-green-600/30 bg-green-600/5 p-3"><p className="flex items-center gap-1 text-xs font-semibold"><CheckCircle2 className="h-3.5 w-3.5" />승인하면</p><p className="mt-1 text-xs">{packet.impact.ifApproved}</p></div>
        <div className="border border-border p-3"><p className="flex items-center gap-1 text-xs font-semibold"><XCircle className="h-3.5 w-3.5" />거절하면</p><p className="mt-1 text-xs">{packet.impact.ifRejected}</p></div>
        <div className="border border-destructive/30 bg-destructive/5 p-3"><p className="flex items-center gap-1 text-xs font-semibold"><AlertTriangle className="h-3.5 w-3.5" />잘못 판단하면</p><p className="mt-1 text-xs">{packet.impact.ifWrong}</p></div>
      </div>
      {(packet.unresolvedFacts.length > 0 || packet.questions.length > 0) && <div className="border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p className="flex items-center gap-1 font-semibold"><HelpCircle className="h-4 w-4" />확인할 내용</p><ul className="mt-1 list-disc pl-5">{[...packet.unresolvedFacts, ...packet.questions].map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs font-semibold text-muted-foreground">다음 단계</dt><dd>{packet.recommendedNextStep}</dd></div><div><dt className="text-xs font-semibold text-muted-foreground">필요한 검토자</dt><dd>{packet.requiredReviewer}</dd></div></dl>
    </section>
  );
}
