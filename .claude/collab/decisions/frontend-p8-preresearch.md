# P8 Frontend Pre-Research

## Schema Reference
Source: `.claude/collab/decisions/frontend-p5-schema-reference.md`

### missions table
- status: `planning | active | paused | completed | cancelled`
- ownerAgentId: NOT NULL (every mission has a PO)
- goalId: FK → goals.id (nullable, onDelete: set null)

### mission_agents table (join)
- role: `executor | reviewer | observer | specialist`

### mission_sessions table
- adapterType, status (active), runCount, expiresAt

### API shape (from goals.ts pattern)
```
GET  /companies/:companyId/missions
POST /companies/:companyId/missions
GET  /missions/:id
PATCH /missions/:id
DELETE /missions/:id
GET  /missions/:id/issues       ← issue tree
GET  /missions/:id/workflow-runs
```

## StatusBadge gaps (status-colors.ts)
Missing mission statuses:
- `planning` → bg-muted (grey, like "planned")
- `active` → bg-green-100 + text-green-700
- `paused` → bg-orange-100 + text-orange-700
- `cancelled` → bg-muted (like "archived")
- `completed` → bg-green-100 + text-green-700

## queryKeys additions needed
```typescript
missions: {
  list: (companyId: string) => ["missions", companyId] as const,
  detail: (id: string) => ["missions", "detail", id] as const,
  issues: (id: string) => ["missions", id, "issues"] as const,
  workflowRuns: (id: string) => ["missions", id, "workflow-runs"] as const,
},
```

## UI patterns to follow
- company-prefixed routing: `/:companyPrefix/missions`, `/:companyPrefix/missions/:id`
- tanstack-query + shadcn/ui + lucide-react
- StatusBadge for status chips
- PageSkeleton variant="list" for loading
- EmptyState for zero-data
- breadcrumb: `[{ label: "Missions" }, { label: mission.title }]`
- Missions primary nav, Issues secondary (Sidebar change in P8-T10)

## Icon candidates for Missions
- Rocket (lucide) — fits "mission" metaphor
- Crosshair — military/operation metaphor
- Target — goal-aligned
