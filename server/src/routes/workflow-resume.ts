import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { resumeRequestSchema } from "@paperclipai/shared/validators/workflow-resume";
import { badRequest, HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { applyResume } from "../services/workflow/resume/apply.js";
import { previewResume, type ResumeSnapshotSigner } from "../services/workflow/resume/preview.js";
import { readResumeRequest } from "../services/workflow/resume/request-store.js";
import { projectResumeRequest } from "../services/workflow/resume/public-views.js";
import { snapshotUuidSchema } from "../services/workflow/resume/snapshot-state.js";
import { workflowResumeCuRoutes } from "./workflow-resume-cu.js";

/**
 * [파일 목적] Task6a workflow resume preview/readback 과 Task6c resume 요청 POST 의 mounted
 *   routes. 기존 workflowRoutes 아래에 router.use 로 mount 된다:
 *     POST /companies/:companyId/missions/:missionId/workflow-resume-requests
 *     GET /companies/:companyId/missions/:missionId/workflow-resume-preview
 *     GET /companies/:companyId/missions/:missionId/workflow-resume-requests/:requestId
 * [계약]
 *   - auth(assertCompanyAccess + assertBoard)가 어떤 조회보다 먼저다. actor none → 401,
 *     agent → 403(assertBoard), 타회사 → 스코프 조회 404.
 *   - path UUID 와 query(workflowRunId UUID, startStepId 1..200)는 strict 파싱 — 배열/미지
 *     query 키는 400. 서명 키는 매 요청 process.env.PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY 에서
 *     읽고, 정확히 64 lowercase hex(32바이트)만 받는다. 누락/오작형은 고정 503
 *     resume_unavailable — 난수/fallback 키를 만들지 않는다. 시크릿을 응답/로그에 노출 금지.
 *   - 요청 readback GET 은 서명 키가 필요 없다.
 *   - POST route 는 uuidParam + auth 전치 후 strict resumeRequestSchema 로 body 를 검증하고,
 *     URL/body companyId·missionId 일치를 서명 키 로드와 applyResume 호출 전에 확인한다.
 *     applyResume 은 독립 body 검증/board 승인, replay-first idempotency, reset+감사 트랜잭션을
 *     계속 소유한다. route 는 201 응답, 전역 error handler 는 HttpError/ZodError 매핑을 담당한다.
 * [명시적 한계 — 이 슬라이스는 목표 인수가 아니다]
 *   - preview 는 외부 predecessor 내구 산출물 검증기와 검토된 policy registry 가 아직 연결되지
 *     않아 missing_evidence / external_effect_unknown 으로 fail-closed 된다(임시 conservative
 *     proof gap). apply/dispatcher 는 실제 계약을 따른다.
 */

const SIGNING_KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const SIGNING_KEY_PATTERN = /^[0-9a-f]{64}$/u;

const previewQuerySchema = z.object({
  workflowRunId: snapshotUuidSchema,
  startStepId: z.string().min(1).max(200),
}).strict();

function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !snapshotUuidSchema.safeParse(value).success) {
    throw badRequest(`Invalid ${name}`);
  }
  return value;
}

/** 서명 키는 매 요청 env 에서 읽는다. 누락/오작형은 고정 503 — fallback/난수 키 없음. */
function loadResumeSigner(): ResumeSnapshotSigner {
  const raw = process.env[SIGNING_KEY_ENV];
  if (typeof raw !== "string" || !SIGNING_KEY_PATTERN.test(raw)) {
    throw new HttpError(503, "resume_unavailable");
  }
  return { key: Buffer.from(raw, "hex"), now: () => new Date() };
}

async function handler(db: Db, run: (req: Request, res: Response) => Promise<void>, req: Request, res: Response, next: NextFunction) {
  try {
    await run(req, res);
  } catch (error) {
    next(error);
  }
}

export function workflowResumeRoutes(db: Db): Router {
  const router = Router();
  router.use(workflowResumeCuRoutes(db));

  router.get(
    "/companies/:companyId/missions/:missionId/workflow-resume-preview",
    (req, res, next) => handler(db, async (getReq, getRes) => {
      const companyId = uuidParam(getReq, "companyId");
      assertCompanyAccess(getReq, companyId);
      assertBoard(getReq);
      const missionId = uuidParam(getReq, "missionId");
      const parsedQuery = previewQuerySchema.safeParse(getReq.query);
      if (!parsedQuery.success) throw badRequest("Invalid resume preview query");
      const signer = loadResumeSigner();
      const result = await previewResume(db, {
        companyId,
        missionId,
        workflowRunId: parsedQuery.data.workflowRunId,
        startStepId: parsedQuery.data.startStepId,
      }, signer);
      getRes.json(result.publicPreview);
    }, req, res, next),
  );

  router.post(
    "/companies/:companyId/missions/:missionId/workflow-resume-requests",
    (req, res, next) => handler(db, async (postReq, postRes) => {
      const companyId = uuidParam(postReq, "companyId");
      assertCompanyAccess(postReq, companyId);
      assertBoard(postReq);
      const missionId = uuidParam(postReq, "missionId");
      const parsedBody = resumeRequestSchema.parse(postReq.body);
      if (parsedBody.companyId !== companyId || parsedBody.missionId !== missionId) {
        throw badRequest("scope_mismatch");
      }
      const view = await applyResume(db, postReq.actor, parsedBody, loadResumeSigner());
      postRes.status(201).json(projectResumeRequest(view));
    }, req, res, next),
  );

  router.get(
    "/companies/:companyId/missions/:missionId/workflow-resume-requests/:requestId",
    (req, res, next) => handler(db, async (getReq, getRes) => {
      const companyId = uuidParam(getReq, "companyId");
      assertCompanyAccess(getReq, companyId);
      assertBoard(getReq);
      const missionId = uuidParam(getReq, "missionId");
      const requestId = uuidParam(getReq, "requestId");
      const view = await readResumeRequest(db, { companyId, missionId, requestId });
      getRes.json(projectResumeRequest(view));
    }, req, res, next),
  );

  return router;
}
