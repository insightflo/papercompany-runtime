import { expect } from "@playwright/test";
import {
  checkSwitch,
  dialogTest,
  desktopViewport,
  editorRunButton,
  expectFocusInsideDialog,
  expectAssociatedFieldError,
  expectNoBrowserPrompt,
  expectRetainedValues,
  expectSpaceDoubleToggle,
  expectSwitchKeyboardToggles,
  expectTabOrder,
  gotoListAndScreenshot,
  heldRunResponder,
  invalidSectionFieldError,
  narrowViewport,
  openRunDialog,
  requiredTagsCheckbox,
  requiredTopicField,
  runCreated,
  runDialog,
  runLabelField,
  runResponderQueue,
  saveScreenshot,
  sectionRadioNoDefault,
  setFirstWorkflow,
  structuredInputError400,
  submitButton,
  withRequiredUrl,
  withRunInputs,
} from "./dialog-helpers";
import { buildDefaultWorkflow } from "./fixtures";

// 브라우저 dialog(window.prompt 등) 금지는 workflowFixture teardown 이 모든 테스트에서
// 전역 시행한다(기록 첨부 포함). 개별 호출은 조기 단정용(6D.1)만 남긴다.

dialogTest.describe("workflow run dialog (desktop)", () => {
  dialogTest.use({ viewport: desktopViewport });

  dialogTest("6D.1 Run opens a dialog, not browser prompts, with defaults and derived note", async ({ page, workflowFixture: fixture }) => {
    await openRunDialog(page);
    expectNoBrowserPrompt(fixture);

    await expect(runDialog(page).getByRole("radio", { name: "매뉴얼", exact: true })).toBeChecked();
    await expect(runDialog(page).getByRole("radio", { name: "개념 설명", exact: true })).not.toBeChecked();
    await expect(runLabelField(page)).toHaveValue("");
    // 파생 입력(영상 ID)은 입력칸 없이 안내만 제공한다.
    await expect(runDialog(page).getByLabel("영상 ID")).toHaveCount(0);
    await expect(runDialog(page).getByText(/영상 ID|자동으로 추출|자동 추출/).first()).toBeVisible();
    await expect(runDialog(page).getByRole("switch", { name: "활성화" })).toHaveAttribute("aria-checked", "false");
    expect(fixture.submissions).toHaveLength(0);
  });

  dialogTest("6D.1 keyboard: radio arrows, checkbox space, switch space/enter, tab order, escape", async ({ page, workflowFixture: fixture }) => {
    await openRunDialog(page);
    const dialog = runDialog(page);
    const manuals = dialog.getByRole("radio", { name: "매뉴얼", exact: true });
    const concepts = dialog.getByRole("radio", { name: "개념 설명", exact: true });
    const tagA = dialog.getByRole("checkbox", { name: "A", exact: true });

    // 라디오: 매뉴얼 기본 선택, ArrowDown 으로 개념 설명으로 이동.
    await expect(manuals).toBeChecked();
    await manuals.press("ArrowDown");
    await expect(concepts).toBeChecked();
    await expect(manuals).not.toBeChecked();

    // 체크박스: 태그 A 는 기본값 ["a"] 로 초기 체크다. 첫 Space 는 해제다.
    await expect(tagA).toBeChecked();
    await expectSpaceDoubleToggle(page, tagA, true);

    // 스위치 토글과 Tab 순서(그룹 진입 시 선택 라디오, 스위치는 역할 탐색)는 헬퍼 참조.
    await expectSwitchKeyboardToggles(page, dialog.getByRole("switch", { name: "활성화" }));
    await expectTabOrder(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fixture.submissions).toHaveLength(0);
  });

  dialogTest("6D.2-1 escape idle submits nothing and reopen resets values and errors", async ({ page, workflowFixture: fixture }) => {
    const base = buildDefaultWorkflow();
    setFirstWorkflow(fixture, withRunInputs(base, [...base.runInputs.slice(0, 4), requiredTopicField()]));
    await openRunDialog(page);
    const dialog = runDialog(page);
    await submitButton(page).click();
    // 오류 "요소 상태"로 단정한다(정적 required 문구가 아님).
    await expect(dialog.getByLabel("주제")).toHaveAttribute("aria-invalid", "true");
    expect(fixture.submissions).toHaveLength(0);

    await dialog.getByRole("radio", { name: "개념 설명", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "A", exact: true }).uncheck();
    await checkSwitch(page, true);
    await runLabelField(page).fill("잠시 넣어본 값");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await editorRunButton(page).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "매뉴얼", exact: true })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "A", exact: true })).toBeChecked();
    await expect(dialog.getByRole("switch", { name: "활성화" })).toHaveAttribute("aria-checked", "false");
    await expect(runLabelField(page)).toHaveValue("");
    await expect(dialog.getByLabel("주제")).not.toHaveAttribute("aria-invalid", "true");
    expect(fixture.submissions).toHaveLength(0);
  });

  dialogTest("6D.2-2 submits real string/array/boolean with trimmed top-level runLabel", async ({ page, workflowFixture: fixture }) => {
    await openRunDialog(page);
    await runLabelField(page).fill("  검증  ");
    await page.getByRole("radio", { name: "개념 설명", exact: true }).check();
    await runDialog(page).getByRole("checkbox", { name: "A", exact: true }).uncheck();
    await checkSwitch(page, true);
    await checkSwitch(page, false);
    await submitButton(page).click();

    await expect.poll(() => fixture.submissions.length).toBe(1);
    const body = fixture.submissions[0]!;
    expect(body).toMatchObject({ runLabel: "검증", metadata: { section: "concepts", enabled: false } });
    expect(body.metadata).toEqual({ section: "concepts", tags: [], enabled: false, url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(body.metadata).not.toHaveProperty("runLabel");
  });

  dialogTest("6D.2-3 switch without default submits false; optional radio without default omitted", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, withRunInputs(buildDefaultWorkflow(), [
      { ...sectionRadioNoDefault(), required: false },
      { key: "enabled", label: "활성화", type: "switch" },
    ]));
    await openRunDialog(page);
    await expect(runDialog(page).getByRole("switch", { name: "활성화" })).toHaveAttribute("aria-checked", "false");
    await submitButton(page).click();

    await expect.poll(() => fixture.submissions.length).toBe(1);
    expect(fixture.submissions[0]).toEqual({ metadata: { enabled: false } });
  });

  dialogTest("6D.2-4 required checkbox and required text show field errors and block independently", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, withRunInputs(buildDefaultWorkflow(), [requiredTagsCheckbox(), requiredTopicField()]));
    await openRunDialog(page);
    const dialog = runDialog(page);
    const tagA = dialog.getByRole("checkbox", { name: "A", exact: true });
    const topic = dialog.getByLabel("주제");
    await expect(tagA).not.toHaveAttribute("aria-invalid", "true");
    await expect(topic).not.toHaveAttribute("aria-invalid", "true");

    await submitButton(page).click();
    await expect(tagA).toHaveAttribute("aria-invalid", "true");
    await expect(topic).toHaveAttribute("aria-invalid", "true");
    await expectAssociatedFieldError(page, tagA);
    await expectAssociatedFieldError(page, topic);
    expect(fixture.submissions).toHaveLength(0);

    await topic.fill("주제 내용");
    await submitButton(page).click();
    await expect(tagA).toHaveAttribute("aria-invalid", "true");
    expect(fixture.submissions, "checkbox 미완료 시 요청이 나가지 않는다").toHaveLength(0);

    await tagA.check();
    await topic.fill("");
    await submitButton(page).click();
    await expectAssociatedFieldError(page, topic);
    await expect(tagA).not.toHaveAttribute("aria-invalid", "true");
    expect(fixture.submissions, "text 미완료 시 요청이 나가지 않는다").toHaveLength(0);
    await topic.fill("주제 내용");
    await submitButton(page).click();
    await expect.poll(() => fixture.submissions.length).toBe(1);
    await expect(dialog).toHaveCount(0);
    expect(fixture.submissions[0]!.metadata).toEqual({ tags: ["a"], topic: "주제 내용" });
  });

  dialogTest("6D.2-5 structured 400 keeps values, focus and labels; corrected retry sends typed values", async ({ page, workflowFixture: fixture }) => {
    fixture.state.setRunResponder(runResponderQueue([
      structuredInputError400([invalidSectionFieldError]),
      runCreated(),
    ]));
    await openRunDialog(page);
    const dialog = runDialog(page);
    await runLabelField(page).fill("재시도 라벨");
    await dialog.getByRole("checkbox", { name: "A", exact: true }).uncheck();
    await checkSwitch(page, true);
    await dialog.getByLabel("영상 URL").fill("https://youtu.be/dQw4w9WgXcQ");
    await submitButton(page).click();

    await expect.poll(() => fixture.submissions.length).toBe(1);
    expect(fixture.submissions[0]).toMatchObject({ runLabel: "재시도 라벨" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(invalidSectionFieldError.message)).toBeVisible();
    await expectFocusInsideDialog(page);
    await expectRetainedValues(page, { runLabel: "재시도 라벨", url: "https://youtu.be/dQw4w9WgXcQ" });

    // 오류 필드(section)를 바로잡고 재제출한다.
    await dialog.getByRole("radio", { name: "개념 설명", exact: true }).check();
    await submitButton(page).click();
    await expect.poll(() => fixture.submissions.length).toBe(2);
    await expect(dialog).toHaveCount(0);
    const retry = fixture.submissions[1]!;
    expect(retry).toMatchObject({ runLabel: "재시도 라벨" });
    expect(retry.metadata).toEqual({
      section: "concepts", tags: [], enabled: true, url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(retry.metadata).not.toHaveProperty("videoId");
  });

  dialogTest("6D.2-6 pending POST blocks double click, Enter bypass and every dismiss path", async ({ page, workflowFixture: fixture }) => {
    const { responder, release } = heldRunResponder();
    fixture.state.setRunResponder(responder);
    await openRunDialog(page);
    await runLabelField(page).fill("대기 중 라벨");
    await submitButton(page).click();
    await expect.poll(() => fixture.submissions.length).toBe(1);

    // 보류 중에는 실행 외 모든 닫기 컨트롤(취소·X 등 이름 무관)도 비활성이다.
    const dialogButtons = runDialog(page).getByRole("button");
    const buttonCount = await dialogButtons.count();
    expect(buttonCount, "실행 버튼 외 닫기 컨트롤이 존재해야 한다").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < buttonCount; i += 1) {
      await expect(dialogButtons.nth(i)).toBeDisabled();
    }

    // 경쟁 이벤트: 강제 dblclick 과 텍스트 필드 Enter 제출 우회를 시도한다(실패를 삼키지 않음).
    await submitButton(page).dblclick({ force: true });
    await runLabelField(page).press("Enter");
    await page.keyboard.press("Escape");
    await expect(runDialog(page)).toBeVisible();
    expect(fixture.submissions).toHaveLength(1);

    release(runCreated());
    await expect(runDialog(page)).toHaveCount(0);
    expect(fixture.submissions).toHaveLength(1);
  });

  dialogTest("6D.2-7 success POST then failed overview refresh does not reopen a retryable form", async ({ page, workflowFixture: fixture }) => {
    await openRunDialog(page);
    fixture.state.failNextOverviewRefresh();
    await submitButton(page).click();

    await expect.poll(() => fixture.submissions.length).toBe(1);
    await expect.poll(() => fixture.state.overviewRequests).toBeGreaterThanOrEqual(2);
    // 실패한 새로고침 이후 늦은 재렌더가 있어도 실행 폼이 재열리지 않는다.
    await page.waitForTimeout(300);
    await expect(runDialog(page)).toHaveCount(0);
    expect(fixture.submissions).toHaveLength(1);
  });

  dialogTest("6D.2-8a definition without run inputs opens one dialog for the run label only", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, withRunInputs(buildDefaultWorkflow(), []));
    await openRunDialog(page);
    await expect(runDialog(page).getByRole("radio")).toHaveCount(0);
    await expect(runDialog(page).getByRole("checkbox")).toHaveCount(0);
    await expect(runDialog(page).getByRole("switch")).toHaveCount(0);
    await runLabelField(page).fill("라벨만");
    await submitButton(page).click();

    await expect.poll(() => fixture.submissions.length).toBe(1);
    const body = fixture.submissions[0]!;
    expect(body).toMatchObject({ runLabel: "라벨만" });
    expect(body.metadata ?? {}).toEqual({});
  });

  dialogTest("6D.2-8b inactive definition does not submit", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, { ...buildDefaultWorkflow(), status: "paused" });
    await page.goto("/WRI/workflows");
    await expect(editorRunButton(page)).toBeDisabled({ timeout: 20_000 });
    await expect(runDialog(page)).toHaveCount(0);
    expect(fixture.submissions).toHaveLength(0);
  });

  dialogTest("6D.3 desktop screenshots from real source incl. workflow-run-dialog fetch", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, withRequiredUrl(buildDefaultWorkflow()));
    await gotoListAndScreenshot(page, "desktop-list.png");
    await openRunDialog(page);
    expect(await saveScreenshot(page, "desktop-open.png")).toBeTruthy();
    expect(fixture.sourceFetches, "브라우저가 이 서버에서 실제 Dialog 소스를 200으로 fetch해야 한다")
      .toContain("/src/pages/workflows/workflow-run-dialog.tsx");
    await runDialog(page).getByLabel("영상 URL").fill("");
    await submitButton(page).click();
    await expect(runDialog(page).getByLabel("영상 URL")).toHaveAttribute("aria-invalid", "true");
    await expect(runDialog(page).getByText(/필수/).first()).toBeVisible();
    expect(await saveScreenshot(page, "desktop-validation.png")).toBeTruthy();
    expect(fixture.submissions).toHaveLength(0);
  });
});

dialogTest.describe("workflow run dialog (narrow)", () => {
  dialogTest.use({ viewport: narrowViewport });
  dialogTest("6D.3 narrow screenshots from real source", async ({ page, workflowFixture: fixture }) => {
    setFirstWorkflow(fixture, withRequiredUrl(buildDefaultWorkflow()));
    await gotoListAndScreenshot(page, "narrow-list.png");
    await openRunDialog(page);
    expect(await saveScreenshot(page, "narrow-open.png")).toBeTruthy();
    await runDialog(page).getByLabel("영상 URL").fill("");
    await submitButton(page).click();
    await expect(runDialog(page).getByLabel("영상 URL")).toHaveAttribute("aria-invalid", "true");
    await expect(runDialog(page).getByText(/필수/).first()).toBeVisible();
    expect(await saveScreenshot(page, "narrow-validation.png")).toBeTruthy();
    expect(fixture.submissions).toHaveLength(0);
  });
});
