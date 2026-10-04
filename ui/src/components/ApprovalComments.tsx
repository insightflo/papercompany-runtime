import type { ApprovalComment } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { Identity } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function ApprovalComments({ comments, agentNameById, commentBody, setCommentBody, isPending, onPost }: {
  comments: ApprovalComment[]; agentNameById: Map<string, string>;
  commentBody: string; setCommentBody: (value: string) => void; isPending: boolean; onPost: () => void;
}) {
  const lang = useCompanyLanguage();
  return <div className="border border-border rounded-lg p-4 space-y-3">
    <h3 className="text-sm font-medium">{L(lang, { en: "Comments", ko: "댓글" })} ({comments.length})</h3>
    <div className="space-y-2">{comments.map((comment) => (
      <div key={comment.id} className="border border-border/60 rounded-md p-3">
        <div className="flex items-center justify-between mb-1">
          {comment.authorAgentId ? <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
            <Identity name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)} size="sm" />
          </Link> : <Identity name="Board" size="sm" />}
          <span className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleString()}</span>
        </div>
        <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
      </div>
    ))}</div>
    <Textarea value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder={L(lang, { en: "Add a comment...", ko: "메모를 입력하세요..." })} rows={3} />
    <div className="flex justify-end"><Button size="sm" onClick={onPost} disabled={!commentBody.trim() || isPending}>
      {isPending ? L(lang, { en: "Posting…", ko: "게시 중…" }) : L(lang, { en: "Post comment", ko: "댓글 게시" })}
    </Button></div>
  </div>;
}
