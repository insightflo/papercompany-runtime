import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";

type IssuePatch = Partial<Pick<
  Issue,
  "title" | "description" | "status" | "priority" | "assigneeAgentId"
>>;

export function createIssuesAdapter(ctx: PluginContext) {
  return {
    async addComment(issueId: string, body: string, companyId: string) {
      return await ctx.issues.createComment(issueId, body, companyId);
    },
    async update(issueId: string, patch: IssuePatch, companyId: string) {
      return await ctx.issues.update(issueId, patch, companyId);
    },
  };
}
