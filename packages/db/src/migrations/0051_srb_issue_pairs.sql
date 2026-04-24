CREATE TABLE "srb_issue_pairs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "srb_links"("id") ON DELETE CASCADE,
  "source_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "mirror_company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "mirror_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "status_sync_mode" text NOT NULL DEFAULT 'blocked_only',
  "last_synced_status" text,
  "last_synced_at" timestamp with time zone,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_srb_issue_pairs_source_issue_id" ON "srb_issue_pairs" ("source_company_id", "source_issue_id");
CREATE INDEX "idx_srb_issue_pairs_mirror_issue_id" ON "srb_issue_pairs" ("mirror_company_id", "mirror_issue_id");
CREATE UNIQUE INDEX "srb_issue_pairs_unique_pair_idx" ON "srb_issue_pairs" ("link_id", "source_issue_id");
