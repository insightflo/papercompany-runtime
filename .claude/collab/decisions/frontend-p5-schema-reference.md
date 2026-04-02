# P5/P8 Mission Schema Reference

> Source: `packages/db/src/schema/` — read-only, for frontend pre-research

## missions table
```typescript
// packages/db/src/schema/missions.ts
missions = {
  id: uuid (PK)
  companyId: uuid (FK → companies.id)
  ownerAgentId: uuid (FK → agents.id) // NOT NULL — PO role
  title: text
  description: text
  status: text (default: "planning") // planning|active|paused|completed|cancelled
  goalId: uuid (FK → goals.id, onDelete: set null)
  startedAt: timestamp
  completedAt: timestamp
  createdAt: timestamp
  updatedAt: timestamp
}
indexes: companyId, ownerAgentId, status, goalId
```

## mission_agents table (join table)
```typescript
// packages/db/src/schema/mission_agents.ts
missionAgents = {
  id: uuid (PK)
  missionId: uuid (FK → missions.id)
  agentId: uuid (FK → agents.id)
  role: text (default: "executor") // executor|reviewer|observer|specialist
  assignedAt: timestamp
}
indexes: missionId, agentId
unique: (missionId, agentId)
```

## mission_sessions table
```typescript
// packages/db/src/schema/mission_sessions.ts
missionSessions = {
  id: uuid (PK)
  missionId: uuid (FK → missions.id)
  agentId: uuid (FK → agents.id)
  companyId: uuid (FK → companies.id)
  sessionSecretId: uuid (FK → company_secrets.id) // NOT plaintext
  adapterType: text
  status: text (default: "active")
  lastActiveAt: timestamp
  runCount: integer (default: 0)
  expiresAt: timestamp
  createdAt: timestamp
}
indexes: missionId, companyId+status, agentId
unique: (missionId, agentId, adapterType)
```

## issues table — mission_id FK (P5-T4 adds this)
```typescript
// packages/db/src/schema/issues.ts
issues = {
  id: uuid (PK)
  companyId: uuid (FK → companies.id)
  projectId: uuid (FK → projects.id, nullable)
  goalId: uuid (FK → goals.id, nullable)
  parentId: uuid (FK → issues.id, self-ref for tree)
  title: text
  description: text
  status: text (default: "backlog")
  priority: text (default: "medium")
  assigneeAgentId: uuid (FK → agents.id, nullable)
  // + 20+ other columns
  // P5-T4 adds: missionId: uuid (FK → missions.id, nullable)
}
```

## Expected API shape (based on goals.ts pattern)
```typescript
// GET /companies/:companyId/missions
// GET /missions/:id
// POST /companies/:companyId/missions
// PATCH /missions/:id
// DELETE /missions/:id
// GET /missions/:id/issues      (issue tree)
// GET /missions/:id/workflow-runs
```

## OQ-4 notes
- owner_agent_id is NOT NULL (every mission must have a PO)
- role enum: executor | reviewer | observer | specialist
- mission_agents is the join table, NOT a denormalized column on missions
- session_token → company_secrets reference (NOT plaintext)

## UI patterns to follow
- company-prefixed routing: /:companyPrefix/missions, /:companyPrefix/missions/:id
- tanstack-query for data fetching
- shcn/ui components + lucide-react icons
- breadcrumb / page skeleton / empty-state patterns
- Status chips for mission status
