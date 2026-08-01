import { createDb, missionSessions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	seedMissionSessionRotationFixture,
	successfulAdapterResult,
	waitForRunTerminal,
} from "./heartbeat-raw-provider-session-rotation.helpers.js";
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
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
	? describe
	: describe.skip;

if (!embeddedPostgresSupport.supported)
	console.warn(
		`Skipping heartbeat raw provider session rotation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
	);

describeEmbeddedPostgres("heartbeat raw provider session rotation", () => {
	let db!: ReturnType<typeof createDb>;
	let tempDb: Awaited<
		ReturnType<typeof startEmbeddedPostgresTestDatabase>
	> | null = null;

	beforeAll(async () => {
		tempDb = await startEmbeddedPostgresTestDatabase(
			"paperclip-heartbeat-session-rotation-",
		);
		db = createDb(tempDb.connectionString);
	}, 60_000);

	afterEach(async () => {
		executeSpy.mockReset();
		await new Promise((resolve) => setTimeout(resolve, 150));
	});

	afterAll(async () => {
		await tempDb?.cleanup();
	});

	it("starts a fresh raw provider session when a mission resumes on a different workflow step issue", async () => {
		const { agentId, companyId, firstIssueId, missionId, secondIssueId } =
			await seedMissionSessionRotationFixture(db);
		const adapterCalls: Array<{
			readonly context: Record<string, unknown>;
			readonly runId: string;
			readonly sessionDisplayId: string | null;
			readonly sessionId: string | null;
		}> = [];

		executeSpy.mockImplementation(
			async (input: {
				context: Record<string, unknown>;
				runId: string;
				runtime: { sessionDisplayId: string | null; sessionId: string | null };
			}) => {
				adapterCalls.push({
					context: input.context,
					runId: input.runId,
					sessionDisplayId: input.runtime.sessionDisplayId,
					sessionId: input.runtime.sessionId,
				});
				return {
					...successfulAdapterResult(),
					sessionId:
						adapterCalls.length === 1 ? "provider-step-a" : "provider-step-b",
				};
			},
		);

		const heartbeat = heartbeatService(db);
		const firstRun = await heartbeat.invoke(
			agentId,
			"on_demand",
			{
				issueId: firstIssueId,
				missionId,
				stepId: "step-a",
				taskId: firstIssueId,
				workflowStepId: "step-a",
			},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!firstRun) throw new Error("Expected first heartbeat run");
		expect((await waitForRunTerminal(heartbeat, firstRun.id)).status).toBe(
			"succeeded",
		);

		const secondRun = await heartbeat.invoke(
			agentId,
			"on_demand",
			{
				issueId: secondIssueId,
				missionId,
				stepId: "step-b",
				taskId: secondIssueId,
				workflowStepId: "step-b",
			},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!secondRun) throw new Error("Expected second heartbeat run");
		const secondFinalized = await waitForRunTerminal(heartbeat, secondRun.id);
		expect(secondFinalized.status).toBe("succeeded");

		const ownCalls = adapterCalls.filter(
			(call) => call.runId === firstRun.id || call.runId === secondRun.id,
		);
		expect(ownCalls).toHaveLength(2);
		expect(ownCalls[0]?.sessionId).toBeNull();
		expect(ownCalls[1]?.sessionId).toBeNull();
		expect(ownCalls[1]?.sessionDisplayId).toBeNull();
		expect(ownCalls[1]?.context.paperclipSessionRotationReason).toContain(
			firstIssueId,
		);
		expect(ownCalls[1]?.context.paperclipSessionRotationReason).toContain(
			secondIssueId,
		);
		expect(ownCalls[1]?.context.paperclipPreviousSessionId).toBe(
			"provider-step-a",
		);
		expect(secondFinalized.sessionIdBefore).toBeNull();
		expect(secondFinalized.contextSnapshot?.paperclipPreviousSessionId).toBe(
			"provider-step-a",
		);

		const [session] = await db
			.select()
			.from(missionSessions)
			.where(eq(missionSessions.missionId, missionId))
			.limit(1);
		expect(session).toEqual(
			expect.objectContaining({ agentId, companyId, missionId }),
		);
		if (!session) throw new Error("Expected mission session");
		const secretValue = await secretService(db).resolveSecretValue(
			companyId,
			session.sessionSecretId,
			"latest",
		);
		expect(secretValue).toBe("provider-step-b");
	});

	it("preserves raw provider session resume for a retry of the same workflow step issue", async () => {
		const { agentId, firstIssueId, missionId } =
			await seedMissionSessionRotationFixture(db);
		const sessionIdsSeen: Array<string | null> = [];

		executeSpy.mockImplementation(
			async (input: { runtime: { sessionId: string | null } }) => {
				sessionIdsSeen.push(input.runtime.sessionId);
				return {
					...successfulAdapterResult(),
					sessionId: input.runtime.sessionId ?? "provider-step-a",
				};
			},
		);

		const heartbeat = heartbeatService(db);
		for (let i = 0; i < 2; i += 1) {
			const run = await heartbeat.invoke(
				agentId,
				"on_demand",
				{
					issueId: firstIssueId,
					missionId,
					stepId: "step-a",
					taskId: firstIssueId,
					workflowStepId: "step-a",
				},
				"manual",
				{ actorId: "test-suite", actorType: "system" },
			);
			if (!run) throw new Error("Expected heartbeat run");
			const finalized = await waitForRunTerminal(heartbeat, run.id);
			expect(finalized.status).toBe("succeeded");
			expect(
				finalized.contextSnapshot?.paperclipSessionRotationReason,
			).toBeUndefined();
		}

		expect(sessionIdsSeen).toEqual([null, "provider-step-a"]);
	});

	it("keeps resetTaskSession behavior fresh even when a mission session exists for the same issue", async () => {
		const { agentId, firstIssueId, missionId } =
			await seedMissionSessionRotationFixture(db);
		const sessionIdsSeen: Array<string | null> = [];

		executeSpy.mockImplementation(
			async (input: { runtime: { sessionId: string | null } }) => {
				sessionIdsSeen.push(input.runtime.sessionId);
				return {
					...successfulAdapterResult(),
					sessionId:
						input.runtime.sessionId ??
						`provider-session-${sessionIdsSeen.length}`,
				};
			},
		);

		const heartbeat = heartbeatService(db);
		const firstRun = await heartbeat.invoke(
			agentId,
			"on_demand",
			{
				issueId: firstIssueId,
				missionId,
				stepId: "step-a",
				taskId: firstIssueId,
				workflowStepId: "step-a",
			},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!firstRun) throw new Error("Expected first heartbeat run");
		expect((await waitForRunTerminal(heartbeat, firstRun.id)).status).toBe(
			"succeeded",
		);

		const resetRun = await heartbeat.invoke(
			agentId,
			"on_demand",
			{
				forceFreshSession: true,
				issueId: firstIssueId,
				missionId,
				stepId: "step-a",
				taskId: firstIssueId,
				workflowStepId: "step-a",
			},
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!resetRun) throw new Error("Expected reset heartbeat run");
		const resetFinalized = await waitForRunTerminal(heartbeat, resetRun.id);
		expect(resetFinalized.status).toBe("succeeded");
		expect(
			resetFinalized.contextSnapshot?.paperclipSessionRotationReason,
		).toBeUndefined();
		expect(sessionIdsSeen).toEqual([null, null]);
	});
});
