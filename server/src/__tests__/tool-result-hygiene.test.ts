import { beforeEach, describe, expect, it } from "vitest";
import {
	condenseDuplicateToolErrorBody,
	normalizeToolErrorSignature,
	resetToolErrorHygieneForTests,
} from "../services/tool-result-hygiene.js";

const ERROR_TEXT =
	'Workflow tool "social-search" remote endpoint returned status 400: provider responded `reddit community is not allowed` after 3127ms';

function coreBody(error: string) {
	return { tool: "social-search", source: "core", error };
}

function pluginBody(error: string) {
	return { pluginId: "p1", toolName: "social-search", result: { content: null, error } };
}

describe("tool result hygiene — condenseDuplicateToolErrorBody", () => {
	beforeEach(() => {
		resetToolErrorHygieneForTests();
	});

	it("passes the first occurrence through unchanged", () => {
		const body = coreBody(ERROR_TEXT);
		const out = condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body });
		expect(out.duplicateCount).toBe(1);
		expect(out.body).toBe(body);
		expect(out.body.error).toBe(ERROR_TEXT);
	});

	it("condenses the second identical error for the same run/tool/status", () => {
		condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: coreBody(ERROR_TEXT) });
		const out = condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: coreBody(ERROR_TEXT) });
		expect(out.duplicateCount).toBe(2);
		const error = out.body.error as string;
		expect(error).toContain("duplicate tool error ×2");
		expect(error).toContain("do not retry the same call unchanged");
		// 원문 발췌 유지 — 무엇의 중복인지 에이전트가 알 수 있게
		expect(error.startsWith(ERROR_TEXT.slice(0, 60))).toBe(true);
		expect(error.length).toBeLessThan(ERROR_TEXT.length + 120);
		// shape 보존: 나머지 키는 그대로
		expect(out.body.tool).toBe("social-search");
		expect(out.body.source).toBe("core");
	});

	it("treats only-digit differences (elapsed ms) as the same signature", () => {
		condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: coreBody(ERROR_TEXT) });
		const variant = ERROR_TEXT.replace("3127", "9876");
		const out = condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: coreBody(variant) });
		expect(out.duplicateCount).toBe(2);
	});

	it("keeps distinct runs, tools, and statuses independent", () => {
		condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: coreBody(ERROR_TEXT) });
		expect(condenseDuplicateToolErrorBody({ runId: "run-2", tool: "social-search", status: 500, body: coreBody(ERROR_TEXT) }).duplicateCount).toBe(1);
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "other-tool", status: 500, body: coreBody(ERROR_TEXT) }).duplicateCount).toBe(1);
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 502, body: coreBody(ERROR_TEXT) }).duplicateCount).toBe(1);
	});

	it("condenses nested plugin ToolExecutionResult errors without touching success fields", () => {
		const first = pluginBody(ERROR_TEXT);
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 200, body: first, errorPath: "result.error" }).body).toBe(first);
		const out = condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 200, body: pluginBody(ERROR_TEXT), errorPath: "result.error" });
		expect(out.duplicateCount).toBe(2);
		const inner = out.body.result as Record<string, unknown>;
		expect(inner.error).toContain("duplicate tool error ×2");
		expect(out.body.pluginId).toBe("p1");
		// 성공 응답(에러 없음)은 미변경
		const success = { pluginId: "p1", result: { content: "ok", data: { rows: 3 } } };
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 200, body: success, errorPath: "result.error" }).body).toBe(success);
	});

	it("leaves bodies without a string error untouched", () => {
		const noError = { tool: "social-search", data: { ok: true } };
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 200, body: noError }).body).toBe(noError);
		const objectError = { error: { code: "X" } };
		expect(condenseDuplicateToolErrorBody({ runId: "run-1", tool: "social-search", status: 500, body: objectError }).body).toBe(objectError);
	});
});

describe("tool result hygiene — signature normalization", () => {
	it("masks digits and collapses whitespace case-insensitively", () => {
		expect(normalizeToolErrorSignature("Timeout after 3000 ms")).toBe(normalizeToolErrorSignature("timeout after 9 ms"));
		expect(normalizeToolErrorSignature("Timeout after 3000 ms")).not.toBe(normalizeToolErrorSignature("Unauthorized after 3000 ms"));
	});
});
