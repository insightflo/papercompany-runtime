import type { Approval } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import { timeAgo } from "../lib/timeAgo";
import { ACTIONABLE_APPROVAL_STATUSES } from "../lib/inbox";
import { approvalLabel, defaultTypeIcon, typeIcon } from "./ApprovalPayload";
import { Button } from "./ui/button";

export function ApprovalInboxRow({ approval, requesterName }: {
  approval: Approval; requesterName: string | null;
  onApprove: () => void; onReject: () => void; isPending: boolean;
}) {
  const lang = useCompanyLanguage();
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null, lang);
  const showResolutionButtons = approval.type !== "budget_override_required" && ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  return (
    <div className="border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2">
      <div className="flex items-start gap-2 sm:items-center">
        <Link to={`/approvals/${approval.id}`} className="flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors hover:bg-accent/50">
          <span className="hidden h-2 w-2 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex" aria-hidden="true" />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0"><Icon className="h-4 w-4 text-muted-foreground" /></span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">{label}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span title={approval.status}>{humanLabel(lang, "approvalStatus", approval.status).label}</span>
              {requesterName ? <span>{L(lang, { en: `requested by ${requesterName}`, ko: `요청: ${requesterName}` })}</span> : null}
              <span>{L(lang, { en: `updated ${timeAgo(approval.updatedAt)}`, ko: `${timeAgo(approval.updatedAt)} 갱신` })}</span>
            </span>
          </span>
        </Link>
        {showResolutionButtons ? <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button size="sm" variant="outline" className="h-8 px-3" asChild><Link to={`/approvals/${approval.id}`}>{L(lang, { en: "Review & decide", ko: "검토 후 결정" })}</Link></Button>
        </div> : null}
      </div>
      {showResolutionButtons ? <div className="mt-3 flex gap-2 sm:hidden">
        <Button size="sm" variant="outline" className="h-8 px-3" asChild><Link to={`/approvals/${approval.id}`}>{L(lang, { en: "Review & decide", ko: "검토 후 결정" })}</Link></Button>
      </div> : null}
    </div>
  );
}
