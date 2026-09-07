import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowDefinitions } from "./workflow_definitions.js";

/**
 * [purpose] n8n-style inbound webhook 구성. 워크플로우당 1행(UNIQUE workflow_id).
 * secret_ref 는 versioned company secret 의 name 참조("workflow-webhook:<workflowId>").
 * 시크릿 값은 이 테이블에 저장하지 않고 company_secrets/company_secret_versions 에만 둔다.
 */
export const workflowWebhookConfigs = pgTable(
  "workflow_webhook_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    secretRef: text("secret_ref").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    secretLast4: text("secret_last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowIdUq: uniqueIndex("workflow_webhook_configs_workflow_id_uq").on(table.workflowId),
    companyIdIdx: index("idx_workflow_webhook_configs_company_id").on(table.companyId),
  }),
);

/**
 * [purpose] 웹훅 수신 접수(admission) 영수증. 멱등키 재생 방지 + 쿼타 윈도우 카운트.
 * (company_id, workflow_id, idempotency_key) UNIQUE — 동시 수신에서도 1행만 성립.
 * run_id 는 트리거 성공 후 바인딩되는 표시 값이며 실행 권위가 아니다.
 */
export const workflowWebhookDeliveries = pgTable(
  "workflow_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    runId: uuid("run_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("workflow_webhook_deliveries_idempotency_uq").on(
      table.companyId,
      table.workflowId,
      table.idempotencyKey,
    ),
    windowIdx: index("idx_workflow_webhook_deliveries_workflow_received_at").on(
      table.workflowId,
      table.receivedAt,
    ),
  }),
);
