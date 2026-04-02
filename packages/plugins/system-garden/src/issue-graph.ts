type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  parentId?: string | null;
};

type AgentLike = {
  id: string;
  name: string;
};

type CommentLike = {
  body: string;
};

type GraphNode = {
  id: string;
  label: string;
  kind: "issue" | "agent";
  status: string;
  role: string;
};

type GraphEdge = {
  source: string;
  target: string;
  label: string;
};

export async function buildMissionIssueGraph(input: {
  issues: IssueLike[];
  agentsById: Map<string, AgentLike>;
  loadComments: (issueId: string) => Promise<CommentLike[]>;
  maxDepth?: number;
}): Promise<{
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  seedIssueIds: string[];
}> {
  const issueById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const issueByIdentifier = new Map(
    input.issues
      .filter((issue) => issue.identifier)
      .map((issue) => [issue.identifier as string, issue]),
  );

  const nodes: GraphNode[] = [];
  const seenNodeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  function addNode(node: GraphNode) {
    if (seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    nodes.push(node);
  }

  function addEdge(source: string, target: string, label: string) {
    const key = `${source}:${target}:${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target, label });
  }

  function extractIdentifiers(text: string): string[] {
    const matches = text.match(/[A-Z][A-Z0-9]+-\d+/g) ?? [];
    return [...new Set(matches)];
  }

  for (const issue of input.issues) {
    addNode({
      id: issue.id,
      label: issue.identifier ?? issue.title,
      kind: "issue",
      status: issue.status,
      role: "issue",
    });

    if (issue.assigneeAgentId) {
      const agent = input.agentsById.get(issue.assigneeAgentId);
      addNode({
        id: issue.assigneeAgentId,
        label: agent?.name ?? issue.assigneeAgentId,
        kind: "agent",
        status: "active",
        role: "agent",
      });
      addEdge(issue.id, issue.assigneeAgentId, "assignee");
    }

    if (issue.parentId && issueById.has(issue.parentId)) {
      addEdge(issue.id, issue.parentId, "parent");
    }

    for (const identifier of extractIdentifiers(issue.title)) {
      const referenced = issueByIdentifier.get(identifier);
      if (!referenced || referenced.id === issue.id) continue;
      const label = issue.title.includes("재이슈") ? "reissue" : "related";
      addEdge(referenced.id, issue.id, label);
    }

    const comments = await input.loadComments(issue.id);
    for (const comment of comments) {
      for (const identifier of extractIdentifiers(comment.body)) {
        const referenced = issueByIdentifier.get(identifier);
        if (!referenced || referenced.id === issue.id) continue;
        const label = /생성|follow-up|followup/i.test(comment.body)
          ? "spawned_followup"
          : "related";
        addEdge(issue.id, referenced.id, label);
      }
    }
  }

  return {
    graph: { nodes, edges },
    seedIssueIds: input.issues.map((issue) => issue.id),
  };
}
