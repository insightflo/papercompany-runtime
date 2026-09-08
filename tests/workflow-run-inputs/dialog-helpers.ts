import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  buildDefaultWorkflow,
  installWorkflowFixture,
  runId,
  workflowId,
  type FixtureWorkflow,
  type RunInputDeclaration,
  type RunResponderResult,
  type RunResponder,
  type WorkflowFixture,
} from "./fixtures";

/**
 * [목적] dialog.spec.ts 공통 흐름 도우미. 내비게이션·Dialog 오픈·브라우저 프롬프트 단정·
 * 스크린샷 저장·순차 POST 응답기를 제공하고, workflowFixture(test.extend)로 픽스처를
 * 주입해 spec 파일이 300줄 아래를 유지하게 한다.
 */

export const desktopViewport = { width: 1440, height: 900 };
export const narrowViewport = { width: 390, height: 844 };

/**
 * 모든 6D 테스트는 이 테스트 객체로 실행되어야 한다. workflowFixture teardown 에서
 * 브라우저 dialog 이벤트(window.prompt 등) 기록이 비었음을 전역 시행한다(중요 리뷰 4).
 * 테스트 본문이 조기 실패해도 teardown 은 실행되므로, 기록이 있으면 첨부 증거로 남고
 * 어단 어설션이 실패로 기록된다. 개별 호출부(expectNoBrowserPrompt)에 의존하지 않는다.
 */
export const dialogTest = test.extend<{ workflowFixture: WorkflowFixture }>({
  workflowFixture: async ({ page }, use, testInfo) => {
    const fixture = await installWorkflowFixture(page);
    await use(fixture);
    if (fixture.browserDialogs.length > 0) {
      await testInfo.attach("browser-dialog-events", {
        body: JSON.stringify(fixture.browserDialogs, null, 2),
        contentType: "application/json",
      });
    }
    expectNoBrowserPrompt(fixture);
  },
});

export function withRunInputs(workflow: FixtureWorkflow, runInputs: RunInputDeclaration[]): FixtureWorkflow {
  return { ...workflow, runInputs };
}

/** 정의 목록의 첫 워크플로를 교체한다(로드 시 첫 정의가 편집 셸로 자동 열린다). */
export function setFirstWorkflow(fixture: WorkflowFixture, workflow: FixtureWorkflow): void {
  fixture.state.workflows.splice(0, 1, workflow);
}

export function sectionRadioNoDefault(): RunInputDeclaration {
  return {
    key: "section", label: "콘텐츠 종류", type: "radio",
    options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }],
  };
}

export function requiredTopicField(): RunInputDeclaration {
  return { key: "topic", label: "주제", type: "text", required: true };
}

export function requiredTagsCheckbox(): RunInputDeclaration {
  return { key: "tags", label: "태그", type: "checkbox", required: true, options: [{ value: "a", label: "A" }] };
}

/** 검증 스크린샷용: url의 기존 필수 의미를 명시한다. 제출 전 값은 테스트가 비운다. */
export function withRequiredUrl(workflow: FixtureWorkflow): FixtureWorkflow {
  return withRunInputs(workflow, buildDefaultWorkflow().runInputs.map(
    (input) => (input.key === "url" ? { ...input, required: true } : input),
  ));
}

export function runCreated(): RunResponderResult {
  return { status: 201, body: { runId, workflowId, status: "running" } };
}

export async function checkSwitch(page: Page, toChecked: boolean): Promise<void> {
  const sw = runDialog(page).getByRole("switch", { name: "활성화" });
  const current = await sw.getAttribute("aria-checked");
  if ((current === "true") !== toChecked) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", toChecked ? "true" : "false");
}

/** 정의는 로드 시 첫 워크플로가 편집 셸로 자동 열린다(definitions-table useEffect).
 *  셸 액션 바의 Run 버튼이 기본 실행 액션이며, 목록의 "▶ Run"과 같은 onRunWorkflow 를 호출한다. */
export function editorRunButton(page: Page): Locator {
  return page.getByRole("button", { name: "Run", exact: true });
}

export function runDialog(page: Page): Locator {
  return page.getByRole("dialog");
}

export function submitButton(page: Page): Locator {
  return runDialog(page).getByRole("button", { name: "실행", exact: true });
}

export function runLabelField(page: Page): Locator {
  return runDialog(page).getByLabel("실행명 (선택)");
}

/** 정의 목록을 열고 목록 상태 스크린샷을 저장한다(6D.3 공통 전주). */
export async function gotoListAndScreenshot(page: Page, name: string): Promise<void> {
  await page.goto("/WRI/workflows");
  await expect(editorRunButton(page)).toBeVisible({ timeout: 20_000 });
  expect(await saveScreenshot(page, name)).toBeTruthy();
}

/** 정의 행의 Run 액션으로 실행 Dialog를 연다. 소스 정의가 아니면 여기서 실패한다. */
export async function openRunDialog(page: Page): Promise<void> {
  await page.goto("/WRI/workflows");
  await expect(editorRunButton(page)).toBeVisible({ timeout: 20_000 });
  await editorRunButton(page).click();
  await expect(runDialog(page)).toBeVisible({ timeout: 20_000 });
}

/** 브라우저 dialog 이벤트(window.prompt 등)는 전부 실패다. 기록이 비어 있어야 한다.
 *  workflowFixture teardown 이 모든 테스트에 호출하므로 개별 호출은 조기 단정용만 남긴다. */
export function expectNoBrowserPrompt(fixture: WorkflowFixture): void {
  const detail = fixture.browserDialogs.map((d) => `${d.type}: ${d.message}`).join("\n");
  expect(fixture.browserDialogs, `browser dialog events must not fire (window.prompt 금지):\n${detail}`).toHaveLength(0);
}

export async function saveScreenshot(page: Page, name: string): Promise<string> {
  const file = test.info().outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export async function expectAssociatedFieldError(page: Page, control: Locator): Promise<void> {
  await expect(control).toHaveAttribute("aria-invalid", "true");
  const errorId = await control.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  const message = page.locator(`[id="${errorId}"]`);
  await expect(message).toBeVisible();
  await expect(message).toContainText("필수");
}

/** POST 응답을 순서대로 돌려준다. 소진되면 마지막 응답을 반복한다. */
export function runResponderQueue(results: RunResponderResult[]): RunResponder {
  let index = 0;
  return async () => {
    const result = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return result;
  };
}

/** 응답을 보류하는 POST 응답기와 해제 함수를 돌려준다(6D.2-6 대기 상태 재현). */
export function heldRunResponder(): { responder: RunResponder; release: (result: RunResponderResult) => void } {
  let release!: (result: RunResponderResult) => void;
  const held = new Promise<RunResponderResult>((resolve) => { release = resolve; });
  return { responder: async () => held, release };
}

/**
 * 합성 전송/UI 테스트용 필드 오류. invalid_option 을 라디오(선택 필드)에 적용해
 * 공유 정규화기의 선택지 검증과 같은 계약 형태를 유지한다(서버 거부 시연이 아님).
 */
export const invalidSectionFieldError = {
  key: "section",
  code: "invalid_option",
  message: "'콘텐츠 종류' 항목 값이 선택 목록에 없습니다.",
} as const;

/** 서버 구조화 400 계약과 동일한 형태({error, details:{version:1,code,fieldErrors}}). */
export function structuredInputError400(fieldErrors: ReadonlyArray<Record<string, unknown>>): RunResponderResult {
  return {
    status: 400,
    body: {
      error: "실행 입력 검증에 실패했습니다.",
      details: { version: 1, code: "invalid_workflow_run_inputs", fieldErrors },
    },
  };
}

/** [브리프 6D.2-5] 400 이후 변경된 값이 유지되는지 단정한다(기본 5개 선언 기준). */
export async function expectRetainedValues(page: Page, values: { runLabel: string; url: string }): Promise<void> {
  const dialog = runDialog(page);
  await expect(runLabelField(page)).toHaveValue(values.runLabel);
  await expect(dialog.getByRole("radio", { name: "매뉴얼", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "A", exact: true })).not.toBeChecked();
  await expect(dialog.getByRole("switch", { name: "활성화" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByLabel("영상 URL")).toHaveValue(values.url);
}

/** [브리프 6D.2-5] focus/label associations remain — 400 이후 포커스가 Dialog 밖으로
 *  빠져나가면 실패한다. 어느 컨트롤에 머무는지는 구현에 위임한다(과잉 제약 방지). */
export async function expectFocusInsideDialog(page: Page): Promise<void> {
  const inside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  });
  expect(inside, "400 이후 포커스가 Dialog 내부에 남아 있어야 한다").toBe(true);
}

/** [브리프 6D.1] 체크박스 Space 토글: 초기 상태에서 Space 두 번이면 원상 복귀된다. */
export async function expectSpaceDoubleToggle(page: Page, control: Locator, initiallyChecked: boolean): Promise<void> {
  await control.focus();
  await page.keyboard.press("Space");
  await expect(control).toBeChecked({ checked: !initiallyChecked });
  await page.keyboard.press("Space");
  await expect(control).toBeChecked({ checked: initiallyChecked });
}

/** [브리프 6D.1] 스위치는 Space/Enter 모두 토글하며 aria-checked 를 갱신한다. */
export async function expectSwitchKeyboardToggles(page: Page, sw: Locator): Promise<void> {
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(sw).toHaveAttribute("aria-checked", "false");
}

/** [브리프 6D.1] Tab 순서: 실행명 → 라디오(그룹 진입 시 선택 항목) → 체크박스 →
 *  스위치(DOM 타입 무관, 역할 탐색) → URL 텍스트 → (≤3 정지) 실행 버튼. */
export async function expectTabOrder(page: Page): Promise<void> {
  const dialog = runDialog(page);
  await runLabelField(page).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("radio", { name: "개념 설명", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("checkbox", { name: "A", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("switch", { name: "활성화" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("영상 URL")).toBeFocused();
  const stops = ["", "", ""];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Tab");
    stops[i] = await describeActiveElement(page);
  }
  expect(stops, "실행 버튼이 입력 뒤 Tab 순서에서 닿아야 한다").toContain("button:실행");
}

/** 활성 Tab 이동 대상을 사람이 읽는 라벨로 요약한다(버튼/라디오/체크박스/입력). */
export function describeActiveElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as
      | (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> })
      | null;
    if (!el) return "";
    if (el.tagName === "BUTTON") return `button:${(el.textContent ?? "").trim()}`;
    const type = (el as HTMLInputElement).type ?? "";
    const label = el.labels?.[0]?.textContent?.trim() ?? el.getAttribute("aria-label") ?? "";
    if (type === "radio") return `radio:${label}`;
    if (type === "checkbox") return `checkbox:${label}`;
    return `${type || el.tagName.toLowerCase()}:${label}`;
  });
}
