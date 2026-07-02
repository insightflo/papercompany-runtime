-- Company-scoped permission groups (user/group permissions feature, Phase 1).
--   permission_groups: the group itself (principalType='group' grant target).
--   permission_group_members: user members of a group (user -> group expansion).
--   grant rows live in the existing principal_permission_grants table (no separate grants table).
-- Additive and idempotent. Hand-authored (drizzle-kit journal is stale past 0047); runtime auto-apply
--   reads src/migrations.

CREATE TABLE IF NOT EXISTS "permission_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permission_groups_company_name_unique_idx"
  ON "permission_groups" ("company_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_groups_company_status_idx"
  ON "permission_groups" ("company_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permission_group_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies" ("id"),
  "group_id" uuid NOT NULL REFERENCES "permission_groups" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permission_group_members_company_group_user_unique_idx"
  ON "permission_group_members" ("company_id", "group_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_group_members_company_user_status_idx"
  ON "permission_group_members" ("company_id", "user_id", "status");
