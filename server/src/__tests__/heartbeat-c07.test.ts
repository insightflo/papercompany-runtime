import { randomUUID } from "node:crypto";
import {
	createDb, agents, companies, issues, heartbeatRunEvents, issueComments, activityLog,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { successfulAdapterResult, waitForRunTerminal } from "./heartbeat-raw-provider-session-rotation.helpers.js";
import {
	getEmbeddedPostgresTestSupport,
	startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
	getServerAdapter: vi.fn(() => ({
		supportsLocalAgentJwt: false,
		execute: executeSpy,
	})),
	runningProcesses: new Map(),
}));
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported)
	console.warn("Skipping heartbeat C07 tests: " + (embeddedPostgresSupport.reason ?? "unsupported environment"));

type Db = ReturnType<typeof createDb>;
type Issue = typeof issues.$inferSelect;
type AdapterInput = {
	runId: string;
	context: Record<string, unknown>;
	onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
};

/** 종료 상태 관측보다 늦을 수 있는 issue 정리 커밋을 기존 5초/25ms 간격으로 기다린다. */
async function waitForIssueRow(
	fetch: () => Promise<Issue | null>,
	predicate: (row: Issue | null) => boolean,
): Promise<Issue | null> {
	const deadline = Date.now() + 5_000;
	let row = await fetch();
	while (!predicate(row) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		row = await fetch();
	}
	return row;
}

async function emitRunawayOutput(input: Pick<AdapterInput, "onLog">, chunks: number) {
	for (let i = 0; i < chunks; i += 1) {
		await input.onLog?.("stdout", "x".repeat(20_000) + "\n");
	}
	return {
		...successfulAdapterResult(),
		exitCode: 1,
		errorMessage: "child terminated after runaway output",
		errorCode: null,
	};
}

describeEmbeddedPostgres("heartbeat C07 log and no-progress preservation", () => {
	let db!: Db;
	let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

	beforeAll(async () => {
		tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-c07-");
		db = createDb(tempDb.connectionString);
	}, 60_000);
	afterEach(async () => {
		executeSpy.mockReset();
		await new Promise((resolve) => setTimeout(resolve, 150));
	});
	afterAll(async () => {
		await tempDb?.cleanup();
	});

	async function seedC07Fixture(adapterConfig: Record<string, unknown> = {}) {
		const companyId = randomUUID();
		const agentId = randomUUID();
		const issueId = randomUUID();
		await db.insert(companies).values({
			id: companyId,
			name: "Run Stability",
			issuePrefix: "RST" + companyId.replace(/-/g, "").slice(0, 4).toUpperCase(),
			requireBoardApprovalForNewAgents: false,
		});
		await db.insert(agents).values({
			id: agentId, companyId, name: "Run Stability Agent", role: "engineer",
			status: "active", adapterType: "opencode_local", adapterConfig,
			runtimeConfig: {}, permissions: {},
		});
		await db.insert(issues).values({
			id: issueId, companyId,
			identifier: "RST-" + companyId.slice(0, 4).toUpperCase(),
			title: "Run stability issue", status: "todo", assigneeAgentId: agentId,
		});
		const heartbeat = heartbeatService(db);
		const issueScope = and(eq(issues.id, issueId), eq(issues.companyId, companyId));
		return {
			agentId, companyId, issueId,
			async invoke(withIssue = false) {
				const context = withIssue ? { issueId, taskKey: "issue:" + issueId } : {};
				const run = await heartbeat.invoke(
					agentId, "on_demand", context, "manual",
					{ actorId: "test-suite", actorType: "system" },
				);
				if (!run) throw new Error("Expected heartbeat run");
				return { run, final: await waitForRunTerminal(heartbeat, run.id) };
			},
			async reopenIssue() {
				await db.update(issues).set({ status: "in_progress", completedAt: null }).where(issueScope);
			},
			async linkIssue(runId: string) {
				await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(issueScope);
			},
			waitForIssue(status: string) {
				return waitForIssueRow(
					() => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
					(row) => row?.status === status,
				);
			},
		};
	}

	it("fails a run with runaway_context when the log stream exceeds the configured limit", async () => {
		const { invoke } = await seedC07Fixture({ runawayLogLimitBytes: 60_000 });
		executeSpy.mockImplementation((input: AdapterInput) => emitRunawayOutput(input, 5));
		const { final } = await invoke();
		expect(final.status).toBe("failed");
		expect(final.errorCode).toBe("runaway_context");
	});

	it("emits a soft-threshold advisory event before the runaway kill", async () => {
		const { invoke } = await seedC07Fixture({ runawayLogLimitBytes: 100_000 });
		executeSpy.mockImplementation((input: AdapterInput) => emitRunawayOutput(input, 6));
		const { run, final } = await invoke();
		expect(final.status).toBe("failed");
		expect(final.errorCode).toBe("runaway_context");
		const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
		const advisory = events.find((event) => (event.message ?? "").includes("Runaway advisory"));
		expect(advisory).toBeTruthy();
		expect(advisory?.level).toBe("warn");
	});

	it("injects a runaway recovery brief into the next run for the same issue", async () => {
		const { invoke } = await seedC07Fixture({ runawayLogLimitBytes: 60_000 });
		const contexts: Array<Record<string, unknown>> = [];
		executeSpy.mockImplementation(async (input: AdapterInput) => {
			contexts.push(input.context);
			if (contexts.length === 1) return emitRunawayOutput(input, 5);
			return { ...successfulAdapterResult() };
		});
		const first = await invoke(true);
		expect(first.final.errorCode).toBe("runaway_context");
		const second = await invoke(true);
		expect(second.final.status).toBe("succeeded");
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.paperclipRunawayRecoveryBrief).toMatchObject({
			kind: "runaway_recovery", previousRunId: first.run.id,
		});
		expect(contexts[0]?.paperclipRunawayRecoveryBrief).toBeUndefined();
	});

	it("no-progress ladder: advisory at N, recovery brief on next wake, honest auto-block at K", async () => {
		const { issueId, invoke, reopenIssue, linkIssue, waitForIssue } = await seedC07Fixture();
		const contexts: Array<Record<string, unknown>> = [];
		// 기존 성공→자동 완료→owner 재개봉 입력을 그대로 반복한다.
		await reopenIssue();
		executeSpy.mockImplementation(async (input: AdapterInput) => {
			contexts.push(input.context);
			await linkIssue(input.runId);
			return { ...successfulAdapterResult() };
		});
		const invokeOnIssue = async () => {
			const execution = await invoke(true);
			expect(execution.final.status).toBe("succeeded");
			return execution;
		};

		// 기존 N=2/K=3 계약: 1회는 정상 완료, 2회는 경고, 3회는 회복 지시와 차단.
		const first = await invokeOnIssue();
		let issueRow = await waitForIssue("done");
		expect(issueRow?.status).toBe("done");
		const firstEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, first.run.id));
		expect(firstEvents.some((event) => (event.message ?? "").includes("No-progress advisory"))).toBe(false);
		expect(contexts[0]?.paperclipNoProgressRecoveryBrief).toBeUndefined();
		await reopenIssue();

		const second = await invokeOnIssue();
		issueRow = await waitForIssue("done");
		expect(issueRow?.status).toBe("done");
		const secondEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, second.run.id));
		const advisory = secondEvents.find((event) => (event.message ?? "").includes("No-progress advisory"));
		expect(advisory).toBeTruthy();
		expect(advisory?.level).toBe("warn");
		await reopenIssue();

		await invokeOnIssue();
		expect(contexts[2]?.paperclipNoProgressRecoveryBrief).toMatchObject({
			kind: "no_progress_recovery", consecutiveCount: 2, lastRunId: second.run.id,
		});
		const blockedIssue = await waitForIssue("blocked");
		expect(blockedIssue?.status).toBe("blocked");
		expect(blockedIssue?.executionRunId).toBeNull();
		const blockActivity = await db.select().from(activityLog)
			.where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.no_progress_auto_blocked")))
			.then((rows) => rows[0] ?? null);
		expect(blockActivity).toBeTruthy();
		expect((blockActivity?.details as Record<string, unknown>)?.consecutiveNoProgress).toBe(3);
		expect((blockActivity?.details as Record<string, unknown>)?.reason).toBe("consecutive_no_progress");
		const blockComment = await db.select({ body: issueComments.body }).from(issueComments)
			.where(eq(issueComments.issueId, issueId))
			.then((rows) => rows.map((row) => row.body).join("\n"));
		expect(blockComment).toContain("연속 무진행 실행");
	});

	it("no-progress ladder: structured evidence in the run resets the chain and the issue completes normally", async () => {
		const { agentId, companyId, issueId, invoke, reopenIssue, linkIssue, waitForIssue } = await seedC07Fixture();
		let calls = 0;
		await reopenIssue();
		executeSpy.mockImplementation(async (input: AdapterInput) => {
			calls += 1;
			await linkIssue(input.runId);
			// 이동 단계에서는 댓글 시각으로 연쇄를 끊는 기존 기대를 보존한다.
			// 공식 진척 증거만 인정하는 정책 변경은 후속 지정 단계의 책임이다.
			if (calls >= 3) {
				await db.insert(issueComments).values({
					companyId, issueId, authorAgentId: agentId,
					body: "status: partial deliverable registered",
				});
			}
			return { ...successfulAdapterResult() };
		});
		for (let i = 0; i < 3; i += 1) {
			const { final } = await invoke(true);
			expect(final.status).toBe("succeeded");
			if (i < 2) await reopenIssue();
		}
		const issueRow = await waitForIssue("done");
		expect(issueRow?.status).toBe("done");
		const blockActivities = await db.select().from(activityLog)
			.where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.no_progress_auto_blocked")));
		expect(blockActivities).toHaveLength(0);
	});
});
