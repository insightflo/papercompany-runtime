import crypto from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { workflowWebhookConfigs, workflowWebhookDeliveries } from "@paperclipai/db";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";
import { seedRunInputWorkflow } from "./workflow-run-input-fixture.js";
import { errorHandler } from "../../middleware/index.js";
import {
  webhookRawBodyErrorHandler,
  workflowWebhookRoutes,
} from "../../routes/workflow-webhooks.js";
import { workflowRoutes } from "../../routes/workflows.js";
import { secretService } from "../../services/secrets.js";

/**
 * [목적] Task 6B HTTP 경계 통합 테스트 전용 픽스처. 회사 스코프 보드 액터 Express 앱과
 * raw webhook 앱 조립, 웹훅 서명·전송, 암호화 시크릿/컨피그 시드를 제공한다.
 * [care] 테스트 전용. 실제 회사가 아닌 픽스처가 만든 임시 회사에만 시크릿을 만든다.
 * 서명 규약은 기존 HMAC-SHA256("${timestamp}.${rawBody}") 그대로다(프로토콜 변경 없음).
 */

// [선언] HTTP 경계 테스트 공통 runInputs 선언군. radio required+default, checkbox,
// switch, 필수 text, deriveFrom text를 서피스별로 나눠 담는다(max 5 이하).
export const sectionRadio: WorkflowRunInput = {
  key: "section",
  type: "radio",
  required: true,
  options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }],
  default: "manuals",
};

export const manualFields: WorkflowRunInput[] = [
  sectionRadio,
  { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
  // [care] required 플래그 생략 시 공유 검증기는 required !== false 로 필수로 본다(committed
  // Task 2 단위 테스트 계약). 이 스위치는 "선택형 switch 표면" 커버리지이므로 명시적으로 선택형으로
  // 선언한다. 그렇지 않으면 enabled 누락만으로 별개 required 오류가 섞여 개별 오류 초점 케이스가 깨진다.
  { key: "enabled", type: "switch", required: false },
];

export const webhookFields: WorkflowRunInput[] = [
  sectionRadio,
  { key: "url", type: "text", required: true, placeholder: "https://youtu.be/dQw4w9WgXcQ" },
  { key: "videoId", type: "text", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
];

export const legacyTextFields: WorkflowRunInput[] = [
  { key: "topic", type: "text", required: true },
  sectionRadio,
  { key: "enabled", type: "switch" },
];

/** 구조화 400 계약: {error, details:{version:1, code:"invalid_workflow_run_inputs", fieldErrors}} */
export function invalidInputDetails(fieldErrors: Array<Record<string, unknown>>) {
  return {
    version: 1,
    code: "invalid_workflow_run_inputs",
    fieldErrors,
  };
}

/** 웹훅 서피스 공통 셋업: runInputs 선언 시드 + 시크릿/컨피그 활성화 + raw webhook 앱. */
export async function seedWebhookFixture(db: Db, fields: WorkflowRunInput[]) {
  const seed = await seedRunInputWorkflow(db, fields);
  const secret = await enableWorkflowWebhook(db, seed.companyId, seed.workflowId);
  return { ...seed, secret, app: buildWebhookApp(db) };
}

export function boardActorFor(companyId: string) {
  // source가 local_implicit이 아니므로 companyIds 회사 스코프 강제가 활성화된다.
  return {
    type: "board",
    userId: "board-user-run-input",
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
  };
}

export function buildBoardApp(db: Db, companyId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardActorFor(companyId);
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

export function buildWebhookApp(db: Db): express.Express {
  const app = express();
  app.use(
    "/api/webhooks/workflows",
    express.raw({ limit: "64kb", type: "application/json" }),
    webhookRawBodyErrorHandler,
  );
  app.use("/api", workflowWebhookRoutes(db));
  app.use(errorHandler);
  return app;
}

export function signWebhookSecret(secret: string, timestamp: string, rawBody: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

/** 픽스처 회사 스코프에서 웹훅 시크릿(암호화 저장)과 컨피그를 만들고 평문 시크릿을 돌려준다. */
export async function enableWorkflowWebhook(
  db: Db,
  companyId: string,
  workflowId: string,
): Promise<string> {
  const secretValue = `run-input-webhook-${workflowId.slice(0, 12)}`;
  await secretService(db).create(companyId, {
    name: `workflow-webhook:${workflowId}`,
    provider: "local_encrypted",
    value: secretValue,
  });
  await db.insert(workflowWebhookConfigs).values({
    companyId,
    workflowId,
    secretRef: `workflow-webhook:${workflowId}`,
    enabled: true,
    secretLast4: secretValue.slice(-4),
  });
  return secretValue;
}

export type SignedWebhookOptions = {
  key?: string;
  ts?: string;
  sig?: string;
  omit?: string[];
};

export async function signedWebhookPost(
  app: express.Express,
  workflowId: string,
  secretValue: string,
  rawBody: string,
  opts: SignedWebhookOptions = {},
) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Timestamp": ts,
    "X-Idempotency-Key": opts.key ?? `idem-${crypto.randomUUID()}`,
    "X-Signature": opts.sig ?? signWebhookSecret(secretValue, ts, rawBody),
  };
  for (const header of opts.omit ?? []) delete headers[header];
  return request(app)
    .post(`/api/webhooks/workflows/${workflowId}`)
    .set(headers)
    .send(rawBody);
}

/** 멱등키로 웹훅 delivery 수령 행을 조회한다(거부·리플레이 경계 단언 공용). */
export function webhookDeliveriesByKey(db: Db, idempotencyKey: string) {
  return db
    .select()
    .from(workflowWebhookDeliveries)
    .where(eq(workflowWebhookDeliveries.idempotencyKey, idempotencyKey));
}

/** seedWebhookFixture 결과에 바로 쓰는 JSON 서명 전송 편의 함수(서명 규약 불변). */
export async function signedWebhookJson(
  fixture: { workflowId: string; secret: string; app: express.Express },
  payload: Record<string, unknown>,
  key: string,
  opts: { sig?: string } = {},
) {
  return signedWebhookPost(fixture.app, fixture.workflowId, fixture.secret, JSON.stringify(payload), {
    key,
    ...opts,
  });
}
