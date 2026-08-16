import { randomUUID } from "node:crypto";
import { createDb, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
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
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
	? describe
	: describe.skip;

if (!embeddedPostgresSupport.supported)
	console.warn(
		`Skipping heartbeat run stability tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
	);

type Db = ReturnType<typeof createDb>;

/** 조건을 만족하는 행이 생길 때까지 폴링한다(최대 5초). */
async function waitForRows<T>(fetch: () => Promise<T[]>): Promise<T[]> {
	const deadline = Date.now() + 5_000;
	let rows: T[] = [];
	while (Date.now() < deadline) {
		rows = await fetch();
		if (rows.length > 0) return rows;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return rows;
}

async function seedStabilityFixture(db: Db, adapterConfig: Record<string, unknown>) {
	const { agents, companies, issues } = await import("@paperclipai/db");
	const companyId = randomUUID();
	const agentId = randomUUID();
	const issueId = randomUUID();
	await db.insert(companies).values({
		id: companyId,
		name: "Run Stability",
		issuePrefix: `RST${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
		requireBoardApprovalForNewAgents: false,
	});
	await db.insert(agents).values({
		id: agentId,
		companyId,
		name: "Run Stability Agent",
		role: "engineer",
		status: "active",
		adapterType: "opencode_local",
		adapterConfig,
		runtimeConfig: {},
		permissions: {},
	});
	await db.insert(issues).values({
		id: issueId,
		companyId,
		identifier: `RST-${companyId.slice(0, 4).toUpperCase()}`,
		title: "Run stability issue",
		status: "todo",
		assigneeAgentId: agentId,
	});
	return { agentId, companyId, issueId };
}

describeEmbeddedPostgres("heartbeat run stability", () => {
	let db!: Db;
	let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

	beforeAll(async () => {
		tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-stability-");
		db = createDb(tempDb.connectionString);
	}, 60_000);

	afterEach(async () => {
		executeSpy.mockReset();
		await new Promise((resolve) => setTimeout(resolve, 150));
	});

	afterAll(async () => {
		await tempDb?.cleanup();
	});

	it("queues exactly one same-config retry after a transient adapter_failed run", async () => {
		const { agentId } = await seedStabilityFixture(db, {});
		const heartbeat = heartbeatService(db);
		let calls = 0;

		executeSpy.mockImplementation(async () => {
			calls += 1;
			// Fast non-zero exit with no errorCode → adapter_failed (transient signature).
			return {
				...successfulAdapterResult(),
				exitCode: 1,
				errorMessage: "CLI crashed transiently",
				errorCode: null,
			};
		});

		const firstRun = await heartbeat.invoke(
			agentId,
			"on_demand",
			{},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!firstRun) throw new Error("Expected first heartbeat run");
		const firstFinal = await waitForRunTerminal(heartbeat, firstRun.id);
		expect(firstFinal.status).toBe("failed");
		expect(firstFinal.errorCode).toBe("adapter_failed");

		// finalize(상태 저장)와 retry enqueue는 같은 비동기 체인의 앞뒤 단계다 —
		// 터미널 상태 관측이 enqueue 커밋보다 빨라도 통과해야 하므로 폴링한다.
		const retryRuns = await waitForRows(async () =>
			(await db
				.select()
				.from(heartbeatRuns)
				.where(eq(heartbeatRuns.retryOfRunId, firstRun.id)))
			.filter((row) => row.id !== firstRun.id),
		);
		expect(retryRuns).toHaveLength(1);
		expect(retryRuns[0]?.processLossRetryCount).toBe(1);
		const [retryWakeup] = await db
			.select()
			.from(agentWakeupRequests)
			.where(eq(agentWakeupRequests.runId, retryRuns[0]!.id));
		expect(retryWakeup?.reason).toBe("adapter_failed_retry");

		// Process the retry wake; its failure must NOT queue another retry.
		const retryFinal = await waitForRunTerminal(heartbeat, retryRuns[0]!.id);
		expect(retryFinal.status).toBe("failed");
		// finalize 체인의 후속 enqueue를 기다렸다가 2세대 재시도가 없음을 확인한다.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const secondGenRetries = await db
			.select()
			.from(heartbeatRuns)
			.where(eq(heartbeatRuns.retryOfRunId, retryRuns[0]!.id));
		expect(secondGenRetries).toHaveLength(0);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("does not retry adapter_failed runs when the transient retry window is disabled", async () => {
		const { agentId } = await seedStabilityFixture(db, {});
		const heartbeat = heartbeatService(db);
		const prev = process.env.PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC;
		process.env.PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC = "0";
		try {
			executeSpy.mockImplementation(async () => ({
				...successfulAdapterResult(),
				exitCode: 1,
				errorMessage: "CLI crashed transiently",
				errorCode: null,
			}));

			const run = await heartbeat.invoke(
				agentId,
				"on_demand",
				{},
				"manual",
				{ actorId: "test-suite", actorType: "system" },
			);
			if (!run) throw new Error("Expected heartbeat run");
			const final = await waitForRunTerminal(heartbeat, run.id);
			expect(final.status).toBe("failed");
			expect(final.errorCode).toBe("adapter_failed");
			const retries = await db
				.select()
				.from(heartbeatRuns)
				.where(eq(heartbeatRuns.retryOfRunId, run.id));
			expect(retries).toHaveLength(0);
		} finally {
			if (prev === undefined) delete process.env.PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC;
			else process.env.PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC = prev;
		}
	});

	it("does not transient-retry deterministic provider configuration failures", async () => {
		const { agentId } = await seedStabilityFixture(db, {});
		const heartbeat = heartbeatService(db);

		executeSpy.mockImplementation(async () => ({
			...successfulAdapterResult(),
			exitCode: 1,
			errorMessage: "Claude run failed: subtype=success: API Error: 400 Param Incorrect",
			errorCode: null,
			resultJson: {
				type: "result",
				subtype: "success",
				is_error: true,
				api_error_status: 400,
				result: "API Error: 400 Param Incorrect",
			},
		}));

		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const final = await waitForRunTerminal(heartbeat, run.id);
		expect(final.status).toBe("failed");
		const retries = await db
			.select()
			.from(heartbeatRuns)
			.where(eq(heartbeatRuns.retryOfRunId, run.id));
		expect(retries).toHaveLength(0);
	});

	it("fails a run with runaway_context when the log stream exceeds the configured limit", async () => {
		const { agentId } = await seedStabilityFixture(db, { runawayLogLimitBytes: 60_000 });
		const heartbeat = heartbeatService(db);

		executeSpy.mockImplementation(
			async (input: {
				onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
			}) => {
				for (let i = 0; i < 5; i += 1) {
					await input.onLog?.("stdout", `${"x".repeat(20_000)}\n`);
				}
				return {
					...successfulAdapterResult(),
					exitCode: 1,
					errorMessage: "child terminated after runaway output",
					errorCode: null,
				};
			},
		);

		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const final = await waitForRunTerminal(heartbeat, run.id);
		expect(final.status).toBe("failed");
		expect(final.errorCode).toBe("runaway_context");
	});

	it("emits a soft-threshold advisory event before the runaway kill", async () => {
		const { agentId } = await seedStabilityFixture(db, { runawayLogLimitBytes: 100_000 });
		const heartbeat = heartbeatService(db);

		executeSpy.mockImplementation(
			async (input: {
				onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
			}) => {
				// 6 × 20KB = 120KB — soft(60KB)를 먼저 지나 hard(100KB)에 도달
				for (let i = 0; i < 6; i += 1) {
					await input.onLog?.("stdout", `${"x".repeat(20_000)}\n`);
				}
				return {
					...successfulAdapterResult(),
					exitCode: 1,
					errorMessage: "child terminated after runaway output",
					errorCode: null,
				};
			},
		);

		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const final = await waitForRunTerminal(heartbeat, run.id);
		expect(final.status).toBe("failed");
		expect(final.errorCode).toBe("runaway_context");

		const { heartbeatRunEvents } = await import("@paperclipai/db");
		const events = await db
			.select()
			.from(heartbeatRunEvents)
			.where(eq(heartbeatRunEvents.runId, run.id));
		const advisory = events.find((event) => (event.message ?? "").includes("Runaway advisory"));
		expect(advisory).toBeTruthy();
		expect(advisory?.level).toBe("warn");
	});

	it("injects a runaway recovery brief into the next run for the same issue", async () => {
		const { agentId, issueId } = await seedStabilityFixture(db, { runawayLogLimitBytes: 60_000 });
		const heartbeat = heartbeatService(db);
		const contexts: Array<Record<string, unknown>> = [];

		executeSpy.mockImplementation(
			async (input: {
				context: Record<string, unknown>;
				onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
			}) => {
				contexts.push(input.context);
				if (contexts.length === 1) {
					for (let i = 0; i < 5; i += 1) {
						await input.onLog?.("stdout", `${"x".repeat(20_000)}\n`);
					}
					return {
					...successfulAdapterResult(),
					exitCode: 1,
					errorMessage: "child terminated after runaway output",
					errorCode: null,
				};
				}
				return { ...successfulAdapterResult() };
			},
		);

		const first = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, taskKey: `issue:${issueId}` },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!first) throw new Error("Expected first run");
		expect((await waitForRunTerminal(heartbeat, first.id)).errorCode).toBe("runaway_context");

		const second = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, taskKey: `issue:${issueId}` },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!second) throw new Error("Expected second run");
		expect((await waitForRunTerminal(heartbeat, second.id)).status).toBe("succeeded");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.paperclipRunawayRecoveryBrief).toMatchObject({
			kind: "runaway_recovery",
			previousRunId: first.id,
		});
		expect(contexts[0]?.paperclipRunawayRecoveryBrief).toBeUndefined();
	});

	it("backfills evidence on a run terminalized by issue done while the adapter is still executing", async () => {
		const { agentId, companyId, issueId } = await seedStabilityFixture(db, {});
		const heartbeat = heartbeatService(db);

		let releaseAdapter: () => void = () => {};
		const adapterGate = new Promise<void>((resolve) => {
			releaseAdapter = resolve;
		});
		const sessionPath = `/tmp/pi-sessions/final-${randomUUID()}.jsonl`;
		executeSpy.mockImplementation(
			async (input: {
				onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
			}) => {
				await input.onLog?.("stdout", "assistant working\n");
				await adapterGate;
				return {
					...successfulAdapterResult(),
					usage: { inputTokens: 111, outputTokens: 22, cachedInputTokens: 5 },
					sessionId: sessionPath,
					sessionParams: { sessionId: sessionPath, cwd: "/tmp" },
					sessionDisplayId: sessionPath,
				};
			},
		);

		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, taskKey: `issue:${issueId}` },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");

		// Wait until the adapter actually started so finalize hits a running run.
		const startDeadline = Date.now() + 5_000;
		while (executeSpy.mock.calls.length === 0 && Date.now() < startDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(executeSpy.mock.calls.length).toBeGreaterThan(0);

		// The agent marks the issue done mid-run — same service path the issues
		// route takes (finalizeLinkedRunsForIssueStatus).
		const finalized = await heartbeat.finalizeLinkedRunsForIssueStatus({
			issueId,
			companyId,
			status: "done",
			linkedRunIds: [run.id],
		});
		expect(finalized.finalized).toBe(1);

		const terminal = await waitForRunTerminal(heartbeat, run.id);
		expect(terminal.status).toBe("succeeded");

		// The adapter settles after the kill (SIGTERM resolves the child).
		// Evidence must land on the already-terminal row without flipping status.
		releaseAdapter();
		const deadline = Date.now() + 5_000;
		let evidence = await heartbeat.getRun(run.id);
		while (
			Date.now() < deadline &&
			(evidence?.usageJson == null || evidence?.sessionIdAfter == null)
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			evidence = await heartbeat.getRun(run.id);
		}
		expect(evidence?.status).toBe("succeeded");
		expect(evidence?.exitCode).toBe(0);
		expect(evidence?.sessionIdAfter).toBe(sessionPath);
		const usage = (evidence?.usageJson ?? null) as Record<string, unknown> | null;
		expect(usage).toMatchObject({ inputTokens: 111, outputTokens: 22, cachedInputTokens: 5 });
		expect(evidence?.error).toBeNull();
		expect(evidence?.errorCode).toBeNull();
	});
});
