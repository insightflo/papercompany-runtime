import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDb, agentTaskSessions, heartbeatRuns } from "@paperclipai/db";
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
		`Skipping heartbeat session hygiene tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
	);

type Db = ReturnType<typeof createDb>;

async function seedSessionHygieneFixture(
	db: Db,
	opts: { adapterType: "pi_local" | "codex_local" },
) {
	const companyId = randomUUID();
	const agentId = randomUUID();
	const missionId = randomUUID();
	const previousMissionId = randomUUID();
	const issueId = randomUUID();
	const issuePrefix = `SHY${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

	const { agents, companies, issues, missions } = await import("@paperclipai/db");
	await db.insert(companies).values({
		id: companyId,
		name: "Session Hygiene",
		issuePrefix,
		requireBoardApprovalForNewAgents: false,
	});
	await db.insert(agents).values({
		id: agentId,
		companyId,
		name: "Session Hygiene Agent",
		role: "engineer",
		status: "active",
		adapterType: opts.adapterType,
		adapterConfig: {},
		runtimeConfig: {},
		permissions: {},
	});
	await db.insert(missions).values({
		id: missionId,
		companyId,
		ownerAgentId: agentId,
		title: "Session hygiene mission",
		status: "active",
	});
	await db.insert(issues).values({
		id: issueId,
		companyId,
		missionId,
		title: "Session hygiene issue",
		description: "stepId: step-a",
		status: "todo",
		assigneeAgentId: agentId,
		identifier: `${issuePrefix}-1`,
		originKind: "workflow_step",
		originId: "step-a",
	});
	return { agentId, companyId, issueId, missionId, previousMissionId };
}

/** 이전 세션을 가진 run row + mission task session을 시드한다(레거시 누수 시나리오 재현). */
async function seedLegacySessionState(
	db: Db,
	input: {
		agentId: string;
		companyId: string;
		adapterType: string;
		missionId: string;
		issueId: string;
		sessionId: string;
		previousMissionId?: string;
	},
) {
	await db.insert(heartbeatRuns).values({
		id: randomUUID(),
		companyId: input.companyId,
		agentId: input.agentId,
		issueId: input.issueId,
		status: "succeeded",
		sessionIdAfter: input.sessionId,
		contextSnapshot: {
			missionId: input.previousMissionId ?? input.missionId,
			issueId: input.issueId,
		},
	});
	await db.insert(agentTaskSessions).values({
		companyId: input.companyId,
		agentId: input.agentId,
		adapterType: input.adapterType,
		taskKey: `mission:${input.missionId}`,
		sessionParamsJson: { sessionId: input.sessionId },
		sessionDisplayId: input.sessionId,
	});
}

async function writeOversizedSessionFile(messageCount: number): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-hygiene-"));
	const file = path.join(dir, "session.jsonl");
	const lines = [
		JSON.stringify({ type: "session", id: "s1" }),
		...Array.from({ length: messageCount }, (_, index) =>
			JSON.stringify({ type: "message", id: `m${index}`, role: index % 2 === 0 ? "user" : "assistant" }),
		),
	];
	await fs.writeFile(file, lines.join("\n"), "utf8");
	return file;
}

describeEmbeddedPostgres("heartbeat session hygiene", () => {
	let db!: Db;
	let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
	const tempDirs: string[] = [];

	beforeAll(async () => {
		tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-session-hygiene-");
		db = createDb(tempDb.connectionString);
	}, 60_000);

	afterEach(async () => {
		executeSpy.mockReset();
		await new Promise((resolve) => setTimeout(resolve, 150));
	});

	afterAll(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
		await tempDb?.cleanup();
	});

	it("refuses to resume a session that was last used under a different mission", async () => {
		const { agentId, companyId, issueId, missionId, previousMissionId } =
			await seedSessionHygieneFixture(db, { adapterType: "codex_local" });
		await seedLegacySessionState(db, {
			agentId,
			companyId,
			adapterType: "codex_local",
			missionId,
			issueId,
			sessionId: "legacy-shared-session",
			previousMissionId,
		});
		const adapterCalls: Array<{ context: Record<string, unknown>; sessionId: string | null }> = [];

		executeSpy.mockImplementation(
			async (input: { context: Record<string, unknown>; runtime: { sessionId: string | null } }) => {
				adapterCalls.push({
					context: input.context,
					sessionId: input.runtime.sessionId,
				});
				return {
					...successfulAdapterResult(),
					sessionId: input.runtime.sessionId ?? "fresh-after-mission-rotation",
				};
			},
		);

		const heartbeat = heartbeatService(db);
		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, missionId, stepId: "step-a", taskId: issueId, workflowStepId: "step-a" },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const finalized = await waitForRunTerminal(heartbeat, run.id);
		expect(finalized.status).toBe("succeeded");

		expect(adapterCalls).toHaveLength(1);
		expect(adapterCalls[0]?.sessionId).toBeNull();
		expect(adapterCalls[0]?.context.paperclipSessionRotationReason).toContain("mission changed");
		expect(adapterCalls[0]?.context.paperclipSessionRotationReason).toContain(previousMissionId);
		expect(adapterCalls[0]?.context.paperclipPreviousSessionId).toBe("legacy-shared-session");
	});

	it("rotates a session whose resumed message history exceeds the cap", async () => {
		const { agentId, companyId, issueId, missionId } =
			await seedSessionHygieneFixture(db, { adapterType: "pi_local" });
		const sessionFile = await writeOversizedSessionFile(45);
		tempDirs.push(path.dirname(sessionFile));
		await seedLegacySessionState(db, {
			agentId,
			companyId,
			adapterType: "pi_local",
			missionId,
			issueId,
			sessionId: sessionFile,
		});
		const adapterCalls: Array<{ context: Record<string, unknown>; sessionId: string | null }> = [];

		executeSpy.mockImplementation(
			async (input: { context: Record<string, unknown>; runtime: { sessionId: string | null } }) => {
				adapterCalls.push({
					context: input.context,
					sessionId: input.runtime.sessionId,
				});
				return {
					...successfulAdapterResult(),
					sessionId: input.runtime.sessionId ?? "fresh-after-message-cap",
				};
			},
		);

		const heartbeat = heartbeatService(db);
		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, missionId, stepId: "step-a", taskId: issueId, workflowStepId: "step-a" },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const finalized = await waitForRunTerminal(heartbeat, run.id);
		expect(finalized.status).toBe("succeeded");

		expect(adapterCalls).toHaveLength(1);
		expect(adapterCalls[0]?.sessionId).toBeNull();
		expect(adapterCalls[0]?.context.paperclipSessionRotationReason).toContain("45 messages");
		expect(adapterCalls[0]?.context.paperclipPreviousSessionId).toBe(sessionFile);
	});

	it("resumes a session that is under the message cap on the same mission and issue", async () => {
		const { agentId, companyId, issueId, missionId } =
			await seedSessionHygieneFixture(db, { adapterType: "pi_local" });
		const sessionFile = await writeOversizedSessionFile(5);
		tempDirs.push(path.dirname(sessionFile));
		await seedLegacySessionState(db, {
			agentId,
			companyId,
			adapterType: "pi_local",
			missionId,
			issueId,
			sessionId: sessionFile,
		});
		const sessionIdsSeen: Array<string | null> = [];

		executeSpy.mockImplementation(
			async (input: { runtime: { sessionId: string | null } }) => {
				sessionIdsSeen.push(input.runtime.sessionId);
				return {
					...successfulAdapterResult(),
					sessionId: input.runtime.sessionId ?? "should-not-happen",
				};
			},
		);

		const heartbeat = heartbeatService(db);
		const run = await heartbeat.invoke(
			agentId,
			"on_demand",
			{ issueId, missionId, stepId: "step-a", taskId: issueId, workflowStepId: "step-a" },
			"manual",
			{ actorId: "test-suite", actorType: "system" },
		);
		if (!run) throw new Error("Expected heartbeat run");
		const finalized = await waitForRunTerminal(heartbeat, run.id);
		expect(finalized.status).toBe("succeeded");
		expect(finalized.contextSnapshot?.paperclipSessionRotationReason).toBeUndefined();
		expect(sessionIdsSeen).toEqual([sessionFile]);
	});
});
