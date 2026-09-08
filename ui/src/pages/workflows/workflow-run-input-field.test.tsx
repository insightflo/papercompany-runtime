import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkflowRunInputOption } from "./workflow-page-types.js";
import { WorkflowRunInputField } from "./workflow-run-input-field.js";

// Markup contracts only; keyboard/click behavior is covered by the isolated browser suite.
const options = [{ value: " manuals ", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }];
const noop = () => {};
function render(input: WorkflowRunInputOption, value?: string | string[] | boolean, error?: string) {
  return renderToStaticMarkup(<WorkflowRunInputField input={input} value={value}
    error={error} disabled={false} onChange={noop} />);
}
function attribute(tag: string, name: string): string {
  const value = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  expect(value, `${name} on ${tag}`).toBeDefined();
  return value!;
}
function expectErrorLink(html: string, tag: string) {
  expect(tag).toContain('aria-invalid="true"');
  const errorId = attribute(tag, "aria-describedby");
  expect(html).toContain(`id="${errorId}"`);
  expect(html).toContain("응답을 확인해 주세요.");
}

describe("WorkflowRunInputField static accessibility", () => {
  it("groups native radios by name with exact values and matching option labels", () => {
    const html = render({ key: "section", label: "콘텐츠 종류", type: "radio", options }, " manuals ");
    expect(html).toMatch(/<fieldset[^>]*>/);
    expect(html).toContain("<legend");
    expect(html).toContain("콘텐츠 종류");
    const radios = html.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(attribute(radios[0]!, "name")).toBe(attribute(radios[1]!, "name"));
    radios.forEach((radio, index) => {
      expect(attribute(radio, "value")).toBe(options[index]!.value);
      expect(html).toMatch(new RegExp(`<label[^>]*for="${attribute(radio, "id")}"[^>]*>${options[index]!.label}</label>`));
    });
    expect(radios[0]).toContain('checked=""');
    expect(radios[1]).not.toContain('checked=""');
  });

  it("links each checkbox label and field error to its control", () => {
    const html = render({ key: "tags", label: "태그", type: "checkbox", options }, [], "응답을 확인해 주세요.");
    const controls = html.match(/<button\b[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(controls).toHaveLength(2);
    controls.forEach((control, index) => {
      expect(control).toContain('aria-checked="false"');
      expect(html).toMatch(new RegExp(`<label[^>]*for="${attribute(control, "id")}"[^>]*>${options[index]!.label}</label>`));
      expectErrorLink(html, control);
    });
  });

  it("renders a labelled false switch with linked error and non-submit button type", () => {
    const html = render({ key: "enabled", label: "활성화", type: "switch" }, false, "응답을 확인해 주세요.");
    const control = html.match(/<button\b[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(control).toContain('type="button"');
    expect(control).toContain('aria-checked="false"');
    expect(html).toMatch(new RegExp(`<label[^>]*for="${attribute(control, "id")}"[^>]*>활성화</label>`));
    expectErrorLink(html, control);
  });

  it("links text and radio errors without making required false a missing value", () => {
    const text = render({ key: "topic", label: "주제" }, "", "응답을 확인해 주세요.");
    expectErrorLink(text, text.match(/<input\b[^>]*>/)?.[0] ?? "");
    const radio = render({ key: "section", type: "radio", options }, undefined, "응답을 확인해 주세요.");
    for (const control of radio.match(/<input\b[^>]*>/g) ?? []) expectErrorLink(radio, control);
    const sw = render({ key: "enabled", label: "활성화", type: "switch", required: true }, false);
    expect(sw).toContain('aria-checked="false"');
    expect(sw).not.toContain('aria-invalid="true"');
  });

  it("uses instance-unique IDs and radio names even for repeated declaration keys", () => {
    const input: WorkflowRunInputOption = { key: "section", type: "radio", options };
    const html = renderToStaticMarkup(<>
      <WorkflowRunInputField input={input} value={undefined} disabled={false} onChange={noop} />
      <WorkflowRunInputField input={input} value={undefined} disabled={false} onChange={noop} />
    </>);
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    const names = [...html.matchAll(/\sname="([^"]*)"/g)].map((match) => match[1]);
    expect(names).toHaveLength(4);
    expect(names[0]).not.toBe(names[2]);
  });

  it("explains derived input and source key without any editable control", () => {
    const html = render({ key: "videoId", label: "영상 ID", deriveFrom: { input: "url", extract: "youtubeVideoId" } });
    expect(html).toContain("영상 ID");
    expect(html).toContain("자동으로 추출됩니다");
    expect(html).toContain("url");
    expect(html).not.toMatch(/<(input|button|textarea|select)\b/);
  });

  it("disables every editable control while pending", () => {
    const inputs: WorkflowRunInputOption[] = [
      { key: "topic", label: "주제" }, { key: "section", type: "radio", options },
      { key: "tags", type: "checkbox", options }, { key: "enabled", type: "switch" },
    ];
    for (const input of inputs) {
      const html = renderToStaticMarkup(<WorkflowRunInputField input={input} value={undefined} disabled onChange={noop} />);
      const controls = html.match(/<(?:input|button)\b[^>]*>/g) ?? [];
      expect(controls.length).toBeGreaterThan(0);
      controls.forEach((control) => expect(control).toContain('disabled=""'));
    }
  });
});
