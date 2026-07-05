import { randomUUID } from "node:crypto";
import {
	agents,
	companies,
	type createDb,
	issues,
	missions,
} from "@paperclipai/db";

type HeartbeatRunReader<T extends { readonly status: string }> = {
	readonly getRun: (runId: string) => Promise<T | null>;
};

export async function waitForRunTerminal<T extends { readonly status: string }>(
	heartbeat: HeartbeatRunReader<T>,
	runId: string,
): Promise<T> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const run = await heartbeat.getRun(runId);
		if (run && run.status !== "queued" && run.status !== "running") {
			return run;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for run ${runId} to finish`);
}

export function successfulAdapterResult() {
	return {
		exitCode: 0,
		signal: null,
		timedOut: false,
		errorMessage: null,
		usage: null,
		provider: "test",
		model: "test-model",
		resultJson: null,
		runtimeServices: [],
	};
}

export async function seedMissionSessionRotationFixture(
	db: ReturnType<typeof createDb>,
) {
	const companyId = randomUUID();
	const agentId = randomUUID();
	const missionId = randomUUID();
	const firstIssueId = randomUUID();
	const secondIssueId = randomUUID();
	const issuePrefix = `MSR${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

	await db.insert(companies).values({
		id: companyId,
		name: "Mission Session Rotation",
		issuePrefix,
		requireBoardApprovalForNewAgents: false,
	});
	await db.insert(agents).values({
		id: agentId,
		companyId,
		name: "Mission Session Rotation Agent",
		role: "engineer",
		status: "active",
		adapterType: "codex_local",
		adapterConfig: {},
		runtimeConfig: {},
		permissions: {},
	});
	await db.insert(missions).values({
		id: missionId,
		companyId,
		ownerAgentId: agentId,
		title: "Rotate raw provider sessions by workflow step issue",
		status: "active",
	});
	await db.insert(issues).values([
		{
			id: firstIssueId,
			companyId,
			missionId,
			title: "Workflow step A",
			description: "stepId: step-a",
			status: "todo",
			assigneeAgentId: agentId,
			identifier: `${issuePrefix}-1`,
			originKind: "workflow_step",
			originId: "step-a",
		},
		{
			id: secondIssueId,
			companyId,
			missionId,
			title: "Workflow step B",
			description: "stepId: step-b",
			status: "todo",
			assigneeAgentId: agentId,
			identifier: `${issuePrefix}-2`,
			originKind: "workflow_step",
			originId: "step-b",
		},
	]);

	return { agentId, companyId, firstIssueId, missionId, secondIssueId };
}
