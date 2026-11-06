import type { Request } from "express";
import type { invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { buildInviteOnboardingManifest, type JoinDiagnostic } from "./access-onboarding-manifest.js";

export function buildInviteOnboardingTextDocument(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const manifest = buildInviteOnboardingManifest(req, token, invite, opts);
  const onboarding = manifest.onboarding as {
    inviteMessage?: string | null;
    registrationEndpoint: { method: string; path: string; url: string };
    claimEndpointTemplate: { method: string; path: string };
    textInstructions: { path: string; url: string };
    skill: { path: string; url: string; installPath: string };
    connectivity: {
      diagnostics?: JoinDiagnostic[];
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: { method?: string; path?: string; url?: string };
    };
  };
  const diagnostics = Array.isArray(onboarding.connectivity?.diagnostics)
    ? onboarding.connectivity.diagnostics
    : [];

  const lines: string[] = [];
  const appendBlock = (block: string) => {
    const trimmed = block.replace(/^\n/, "").replace(/\n\s*$/, "");
    const lineIndentation = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^(\s*)/)?.[0].length ?? 0);
    const minIndent =
      lineIndentation.length > 0 ? Math.min(...lineIndentation) : 0;
    for (const line of trimmed.split("\n")) {
      lines.push(line.slice(minIndent));
    }
  };

  appendBlock(`
    # Paperclip OpenClaw Gateway Onboarding

    This document is meant to be readable by both humans and agents.

    ## Invite
    - inviteType: ${invite.inviteType}
    - allowedJoinTypes: ${invite.allowedJoinTypes}
    - expiresAt: ${invite.expiresAt.toISOString()}
  `);

  if (onboarding.inviteMessage) {
    appendBlock(`
      ## Message from inviter
      ${onboarding.inviteMessage}
    `);
  }

  appendBlock(`
    ## Step 0

    Get the OpenClaw gateway auth token (THIS MUST BE SENT)
    Token lives in:

    ~/.openclaw/openclaw.json -> gateway.auth.token
    Extract:

    TOKEN="$(node -p 'require(process.env.HOME+\"/.openclaw/openclaw.json\").gateway.auth.token')"
    test -n "$TOKEN" || (echo "Missing TOKEN" && exit 1)
    test "\${#TOKEN}" -ge 16 || (echo "Gateway token unexpectedly short (\${#TOKEN})" && exit 1)

    3) IMPORTANT: Don't accidentally drop the token when generating JSON
    If you build JSON with Node, pass the token explicitly (argv), don't rely on an un-exported env var.

    Safe payload build looks sort of like this (substitute where necessary):

    BODY="$(node -e '
      const token = process.argv[1];
      if (!token) process.exit(2);
      const body = {
        requestType: "agent",
        agentName: "OpenClaw",
        adapterType: "openclaw_gateway",
        capabilities: "OpenClaw agent adapter",
        agentDefaultsPayload: {
          url: "ws://127.0.0.1:18789",
          paperclipApiUrl: "http://host.docker.internal:3100",
          headers: { "x-openclaw-token": token },
          waitTimeoutMs: 120000,
          sessionKeyStrategy: "issue",
          role: "operator",
          scopes: ["operator.admin"]
        }
      };
      process.stdout.write(JSON.stringify(body));
    ' "$TOKEN")"

    ## Step 1: Submit agent join request
    ${onboarding.registrationEndpoint.method} ${
    onboarding.registrationEndpoint.url
  }

    IMPORTANT: You MUST include agentDefaultsPayload.headers.x-openclaw-token with your gateway token.
    Legacy x-openclaw-auth is also accepted, but x-openclaw-token is preferred.
    Use adapterType "openclaw_gateway" and a ws:// or wss:// gateway URL.
    Pairing mode requirement:
    - Keep device auth enabled (recommended). If devicePrivateKeyPem is omitted, Paperclip generates and persists one during join so pairing approvals are stable.
    - You may set disableDeviceAuth=true only for special environments that cannot support pairing.
    - First run may return "pairing required" once; approve the pending pairing request in OpenClaw, then retry.
    Do NOT use /v1/responses or /hooks/* in this gateway join flow.

    Body (JSON):
    {
      "requestType": "agent",
      "agentName": "My OpenClaw Agent",
      "adapterType": "openclaw_gateway",
      "capabilities": "Optional summary",
      "agentDefaultsPayload": {
        "url": "wss://your-openclaw-gateway.example",
        "paperclipApiUrl": "https://paperclip-hostname-your-agent-can-reach:3100",
        "headers": { "x-openclaw-token": "replace-me" },
        "waitTimeoutMs": 120000,
        "sessionKeyStrategy": "issue",
        "role": "operator",
        "scopes": ["operator.admin"]
      }
    }

    Expected response includes:
    - request id
    - one-time claimSecret
    - claimApiKeyPath

    ## Step 2: Wait for board approval
    The board approves the join request in Paperclip before key claim is allowed.

    ## Step 3: Claim API key (one-time)
    ${
      onboarding.claimEndpointTemplate.method
    } /api/join-requests/{requestId}/claim-api-key

    Body (JSON):
    {
      "claimSecret": "<one-time-claim-secret>"
    }

    On successful claim, save the full JSON response to:

    - ~/.openclaw/workspace/paperclip-claimed-api-key.json
    chmod 600 ~/.openclaw/workspace/paperclip-claimed-api-key.json

    And set the PAPERCLIP_API_KEY and PAPERCLIP_API_URL in your environment variables as specified here:
    https://docs.openclaw.ai/help/environment

    e.g. 

    {
      env: {
        PAPERCLIP_API_KEY: "...",
        PAPERCLIP_API_URL: "...",
      },
    }

    Then set PAPERCLIP_API_KEY and PAPERCLIP_API_URL from the saved token field for every heartbeat run.

    Important:
    - claim secrets expire
    - claim secrets are single-use
    - claim fails before board approval

    ## Step 4: Install Paperclip skill in OpenClaw
    GET ${onboarding.skill.url}
    Install path: ${onboarding.skill.installPath}

    Be sure to prepend your PAPERCLIP_API_URL to the top of your skill and note the path to your PAPERCLIP_API_URL

    ## Text onboarding URL
    ${onboarding.textInstructions.url}

    ## Connectivity guidance
    ${
      onboarding.connectivity?.guidance ??
      "Ensure Paperclip is reachable from your OpenClaw runtime."
    }
  `);

  const connectionCandidates = Array.isArray(
    onboarding.connectivity?.connectionCandidates
  )
    ? onboarding.connectivity.connectionCandidates.filter(
        (entry): entry is string => Boolean(entry)
      )
    : [];

  if (connectionCandidates.length > 0) {
    lines.push("## Suggested Paperclip base URLs to try");
    for (const candidate of connectionCandidates) {
      lines.push(`- ${candidate}`);
    }
    appendBlock(`

      Test each candidate with:
      - GET <candidate>/api/health
      - set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl when submitting your join request

      If none are reachable: ask your human operator for a reachable hostname/address and help them update network configuration.
      For authenticated/private mode, they may need:
      - pnpm paperclipai allowed-hostname <host>
      - then restart Paperclip and retry onboarding.
    `);
  }

  if (diagnostics.length > 0) {
    lines.push("## Connectivity diagnostics");
    for (const diag of diagnostics) {
      lines.push(`- [${diag.level}] ${diag.message}`);
      if (diag.hint) lines.push(`  hint: ${diag.hint}`);
    }
  }

  appendBlock(`

    ## Helpful endpoints
    ${onboarding.registrationEndpoint.path}
    ${onboarding.claimEndpointTemplate.path}
    ${onboarding.skill.path}
    ${manifest.invite.onboardingPath}
  `);

  return `${lines.join("\n")}\n`;
}
