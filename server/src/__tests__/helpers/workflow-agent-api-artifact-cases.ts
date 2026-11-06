// Workflow agent API artifact-registration cases moved out of workflow-agent-api-service.test.ts
// (T16d, file <=1000 lines).
// Slice: workProduct/preview-URL registration, isPrimary semantics, path and image guards, agent-route parity.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import request from "supertest";
import { activityLog, createDb, issueWorkProducts, issues } from "@paperclipai/db";
import { registerWorkflowArtifact, type WorkflowApiActor } from "../../services/workflow/agent-api.js";
import { workProductService } from "../../services/work-products.js";

export function registerWorkflowAgentApiArtifactCases(deps: {
  getDb: () => ReturnType<typeof createDb>;
  tempDirs: Set<string>;
  seedWorkflowIssue: (input: { stepId: string; stepType?: string; title: string; workProductRoot?: string }) => Promise<typeof issues.$inferSelect>;
  seedAssignedWorkflowIssue: (input?: { requestKind?: "workflow_step_runnable" | "workflow_resume" }) => Promise<{ issue: typeof issues.$inferSelect; agentId: string; runId: string; wakeId: string; workflowRunId: string }>;
  actor: WorkflowApiActor;
  createApp: (db: ReturnType<typeof createDb>, actor: { type: "agent"; source: "agent_jwt"; companyId: string; agentId: string; runId?: string }) => import("express").Express;
}) {
  const { getDb, tempDirs, seedWorkflowIssue, seedAssignedWorkflowIssue, actor, createApp } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  it("registers artifacts as official issue workProducts", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-artifact-"));
    tempDirs.add(dir);
    const artifactPath = path.join(dir, "report.md");
    await writeFile(artifactPath, "# Report\n", "utf8");

    // A client-friendly title is canonicalized to the path basename by the server.
    const product = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, title: "Quarterly Report", type: "document", isPrimary: true },
    });
    expect(product).toMatchObject({ provider: "local_file", title: "report.md", type: "document", isPrimary: true });
    // Manually stale the title; a same-path duplicate registration must repair it to the basename.
    await db.update(issueWorkProducts).set({ title: "stale wrong title" }).where(eq(issueWorkProducts.id, product.id));
    const duplicate = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, type: "document", isPrimary: true },
    });
    expect(duplicate.id).toBe(product.id);
    expect(duplicate.title).toBe("report.md");
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ path: artifactPath, registeredVia: "workflow_api" });
  });

  it("registers public preview URLs as official issue workProducts", async () => {
    const issue = await seedWorkflowIssue({ stepId: "publish-entry", title: "[ACTION] Publish entry" });
    const publicUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/260707-llm-document-search/index.html";

    const product = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: {
        type: "preview_url",
        url: publicUrl,
        title: "260707-llm-document-search",
        contentMarker: "260707-llm-document-search",
        isPrimary: true,
      },
    });
    // Second call omits title; the first friendly title must survive (no basename canonicalization for preview_url).
    const duplicate = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { type: "preview_url", url: publicUrl, isPrimary: true },
    });

    expect(product).toMatchObject({
      provider: "public_url",
      title: "260707-llm-document-search",
      type: "preview_url",
      url: publicUrl,
      isPrimary: true,
    });
    expect(duplicate.id).toBe(product.id);
    expect(duplicate.title).toBe("260707-llm-document-search");
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      registeredVia: "workflow_api",
      contentMarker: "260707-llm-document-search",
      deliveryReadback: { required: true, source: "workflow_preview_url" },
    });
  });

  // [PR1 생략 등록 보호] isPrimary 생략 등록은 기존 활성 대표를 강등하지 않는다.
  //   사고(런 56eb185e): build 스텝이 index.html 등록 후 og-image.png를 생략 등록 →
  //   zod default(true) + 신규 true 강등 로직이 대표를 이미지로 교체.
  it("omitted isPrimary keeps the existing active primary and the first omitted registration stays primary", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-omitted-"));
    tempDirs.add(dir);
    const htmlPath = path.join(dir, "index.html");
    const imagePath = path.join(dir, "og-image.png");
    await writeFile(htmlPath, "<html></html>", "utf8");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0xff]));

    // 대표가 없는 첫 생략 등록은 종전대로 대표가 된다(단일 산출물 생략 호출자 호환).
    const first = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: htmlPath, type: "artifact" },
    });
    expect(first.isPrimary).toBe(true);

    // 같은 스코프(company+issue+type)에 활성 대표가 있으면 생략 등록은 비대표로 들어가고
    // 기존 대표는 불변이다.
    const second = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: imagePath, type: "artifact" },
    });
    expect(second.isPrimary).toBe(false);
    const [primaryAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, first.id));
    expect(primaryAfter.isPrimary).toBe(true);
  });

  it("explicit isPrimary:true still replaces the existing primary", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-replace-"));
    tempDirs.add(dir);
    const firstPath = path.join(dir, "first.md");
    const secondPath = path.join(dir, "second.md");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");

    const first = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: firstPath, type: "document" },
    });
    expect(first.isPrimary).toBe(true);

    const second = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: secondPath, type: "document", isPrimary: true },
    });
    expect(second.isPrimary).toBe(true);
    const [firstAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, first.id));
    expect(firstAfter.isPrimary).toBe(false);
  });

  it("explicit isPrimary:false callers keep their observation contract (no demotion, non-primary insert)", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-explicit-false-"));
    tempDirs.add(dir);
    const primaryPath = path.join(dir, "primary.md");
    const sidePath = path.join(dir, "side.md");
    await writeFile(primaryPath, "primary", "utf8");
    await writeFile(sidePath, "side", "utf8");

    const primary = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: primaryPath, type: "document" },
    });

    // 내부 등록 경로(exact-artifact-registration 등)와 동일한 명시 false 계약 — 워크플로우 초크포인트 경유.
    const side = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: sidePath, type: "document", isPrimary: false },
    });
    expect(side.isPrimary).toBe(false);
    const [primaryAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, primary.id));
    expect(primaryAfter.isPrimary).toBe(true);

    // createForIssue 직접 호출자(plan-qa-work-product 등)의 명시 false도 동일 계약.
    const planQaPath = path.join(dir, "plan-qa.md");
    await writeFile(planQaPath, "plan-qa projection", "utf8");
    const direct = await workProductService(db).createForIssue(issue.id, issue.companyId, {
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "document",
      provider: "local_file",
      externalId: planQaPath,
      title: "PLAN-QA projection",
      url: null,
      status: "active",
      reviewState: "none",
      isPrimary: false,
      healthStatus: "unknown",
      summary: null,
      metadata: { path: planQaPath },
      createdByRunId: null,
    });
    expect(direct?.isPrimary).toBe(false);
    const [primaryAfterDirect] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, primary.id));
    expect(primaryAfterDirect.isPrimary).toBe(true);
  });

  it("rejects artifact paths outside the mission workProduct directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-outside-"));
    tempDirs.add(root);
    tempDirs.add(outside);
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report", workProductRoot: root });
    const artifactPath = path.join(outside, "report.md");
    await writeFile(artifactPath, "# Outside\n", "utf8");

    await expect(registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, title: "report.md", type: "document", isPrimary: true },
    })).rejects.toThrow("inside this mission");
  });

  // [하드닝 2단계 2b] 이미지 확장자 파일을 type=document 로 신규 등록하는 것을 거부한다.
  //   문서 자리에 이미지가 앉는 소비 혼동 방지. same-path restamp(기존 산출물 재봉인)은 차단하지 않는다.
  it("rejects new document registrations whose path has an image extension", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-image-doc-"));
    tempDirs.add(dir);
    const pngPath = path.join(dir, "figure.png");
    await writeFile(pngPath, "png-bytes", "utf8");

    await expect(registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: pngPath, type: "document", isPrimary: true },
    })).rejects.toMatchObject({
      status: 422,
      message: "workproduct_document_image_extension_rejected",
      details: { path: pngPath, extension: "png" },
    });

    // 대소문자 무시 — .PNG 도 동일하게 거부되며 extension 은 정규화된 소문자로 보고한다.
    const upperPath = path.join(dir, "figure.PNG");
    await writeFile(upperPath, "png-bytes", "utf8");
    await expect(registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: upperPath, type: "document" },
    })).rejects.toMatchObject({
      status: 422,
      message: "workproduct_document_image_extension_rejected",
      details: { path: upperPath, extension: "png" },
    });

    // 거부된 등록은 워크프로덕트를 남기지 않는다.
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(0);
  });

  it("still allows artifact-typed images, non-image documents, and extensionless document paths", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-image-allow-"));
    tempDirs.add(dir);
    const imagePath = path.join(dir, "og-image.png");
    const jsonPath = path.join(dir, "dataset.json");
    const extensionlessPath = path.join(dir, "report");
    await writeFile(imagePath, "png-bytes", "utf8");
    await writeFile(jsonPath, "{}", "utf8");
    await writeFile(extensionlessPath, "no extension", "utf8");

    // 자산(type=artifact) 은 이미지가 정상이다.
    const asset = await registerWorkflowArtifact({
      db, issue, actor, data: { path: imagePath, type: "artifact" },
    });
    expect(asset).toMatchObject({ type: "artifact", externalId: imagePath });

    // 문서 + 비이미지 확장자 통과.
    const document = await registerWorkflowArtifact({
      db, issue, actor, data: { path: jsonPath, type: "document" },
    });
    expect(document).toMatchObject({ type: "document", externalId: jsonPath });

    // 확장자가 없으면 이미지로 단정할 수 없으므로 통과.
    const extensionless = await registerWorkflowArtifact({
      db, issue, actor, data: { path: extensionlessPath, type: "document" },
    });
    expect(extensionless).toMatchObject({ type: "document", externalId: extensionlessPath });
  });

  it("does not block same-path restamp of an already-registered image document", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-image-restamp-"));
    tempDirs.add(dir);
    const imagePath = path.join(dir, "legacy-figure.png");
    await writeFile(imagePath, "png-bytes", "utf8");

    // 이전(hardening 이전)에 document+이미지로 등록된 기존 산출물 — 워크플로우 API 우회 시드.
    const legacy = await workProductService(db).createForIssue(issue.id, issue.companyId, {
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "document",
      provider: "local_file",
      externalId: imagePath,
      title: "legacy-figure.png",
      url: null,
      status: "active",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "unknown",
      summary: null,
      metadata: { path: imagePath },
      createdByRunId: null,
    });
    expect(legacy).not.toBeNull();

    // 같은 경로 재등록은 restamp/재조정 분기로 처리되고 거부되지 않는다.
    const restamped = await registerWorkflowArtifact({
      db, issue, actor, data: { path: imagePath, type: "document" },
    });
    expect(restamped.id).toBe(legacy?.id);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(1);
  });

  it("routes agent artifact registration through the workflow API", async () => {
    const { issue, agentId, runId } = await seedAssignedWorkflowIssue();
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-route-artifact-"));
    tempDirs.add(dir);
    const artifactPath = path.join(dir, "route-report.md");
    await writeFile(artifactPath, "# Route Report\n", "utf8");

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: issue.companyId,
      agentId,
      runId,
    }))
      .post(`/api/issues/${issue.id}/workflow/artifacts`)
      .send({ path: artifactPath, title: "route-report.md", type: "document" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      issueId: issue.id,
      provider: "local_file",
      title: "route-report.md",
      createdByRunId: runId,
    });
  });

  it("routes agent preview URL registration through the workflow API", async () => {
    const { issue, agentId, runId } = await seedAssignedWorkflowIssue();
    const publicUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/260707-llm-document-search/index.html";

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: issue.companyId,
      agentId,
      runId,
    }))
      .post(`/api/issues/${issue.id}/workflow/artifacts`)
      .send({
        type: "preview_url",
        url: publicUrl,
        title: "260707-llm-document-search",
        contentMarker: "260707-llm-document-search",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      issueId: issue.id,
      provider: "public_url",
      title: "260707-llm-document-search",
      type: "preview_url",
      url: publicUrl,
      createdByRunId: runId,
    });
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(rows[rows.length - 1]?.details).toMatchObject({ type: "preview_url", url: publicUrl });
  });
}
