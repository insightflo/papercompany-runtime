'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CHANGE_SUMMARY_LIMIT,
  REVIEW_INPUT_MODE,
  RUNTIME_ENV_KEYS,
  buildRuntimeHandoff,
  buildRuntimePayload
} = require('../context-injector');

function decodeJwtPayload(token) {
  const [, payloadEncoded] = String(token).split('.');
  return JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8'));
}

describe('context-injector runtime contract', () => {
  let projectRoot;
  let projectConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'context-injector-'));
    projectConfig = {
      domains: [
        {
          name: 'billing',
          scope_profile: 'backend',
          path: 'src/backend/billing',
          resources: {
            api_contract: 'contracts/interfaces/billing-api.yaml'
          }
        },
        {
          name: 'checkout-ui',
          scope_profile: 'frontend',
          path: 'src/frontend/checkout',
          resources: {
            api_contract: 'contracts/interfaces/checkout-ui-api.yaml'
          }
        }
      ]
    };
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('builds a deterministic backend builder payload and writes file-env delivery output', () => {
    const handoff = buildRuntimeHandoff({
      task_id: 'T3.5-backend',
      title: 'Implement billing token refresh',
      domains: ['billing'],
      changed_paths: ['src/backend/billing/service.js', 'prisma/schema.prisma']
    }, {
      targetRole: 'builder',
      projectRoot,
      projectConfig,
      secretKey: 'test-secret',
      nowMs: 1741305600000,
      expiresInSeconds: 900
    });

    expect(handoff.payload).toMatchObject({
      task_id: 'T3.5-backend',
      target_role: 'builder',
      scope_profile: 'backend',
      allowed_paths: ['src/backend/billing/**'],
      allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
      denied_tools: ['chrome-devtools', 'playwright'],
      review_only: false,
      risk_level: 'HIGH',
      contracts: ['contracts/interfaces/billing-api.yaml'],
      change_summary_limit: CHANGE_SUMMARY_LIMIT,
      review_input_mode: REVIEW_INPUT_MODE
    });

    expect(handoff.delivery.mechanism).toBe('file_env');
    expect(handoff.env[RUNTIME_ENV_KEYS.payloadPath]).toBe(handoff.payloadPath);
    expect(handoff.env[RUNTIME_ENV_KEYS.scopedToken]).toBe(handoff.scopedToken);
    expect(handoff.env[RUNTIME_ENV_KEYS.agentToken]).toBe(handoff.scopedToken);
    expect(fs.existsSync(handoff.payloadPath)).toBe(true);

    const writtenPayload = JSON.parse(fs.readFileSync(handoff.payloadPath, 'utf8'));
    expect(writtenPayload).toEqual(handoff.payload);

    expect(handoff.scopedToken.split('.')).toHaveLength(3);
    expect(decodeJwtPayload(handoff.scopedToken)).toMatchObject({
      role: 'builder-backend',
      domain: 'backend',
      scope_id: 'T3.5-backend:builder:backend',
      allowed_paths: ['src/backend/billing/**'],
      review_only: false,
      allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
      denied_tools: ['chrome-devtools', 'playwright'],
      advisory_only: true,
      task_id: 'T3.5-backend',
      scope_profile: 'backend'
    });
  });

  test('backend and frontend fixtures generate different scope profiles and advisory tool contracts', () => {
    const backendPayload = buildRuntimePayload({
      task_id: 'T3.5-backend-only',
      domains: ['billing'],
      changed_paths: ['src/backend/billing/controller.js']
    }, {
      targetRole: 'builder',
      projectConfig
    });

    const frontendPayload = buildRuntimePayload({
      task_id: 'T3.5-frontend-only',
      domains: ['checkout-ui'],
      scope_profile: 'frontend',
      changed_paths: ['src/frontend/checkout/page.tsx']
    }, {
      targetRole: 'builder',
      projectConfig
    });

    expect(backendPayload.scope_profile).toBe('backend');
    expect(frontendPayload.scope_profile).toBe('frontend');
    expect(backendPayload.allowed_paths).toEqual(['src/backend/billing/**']);
    expect(frontendPayload.allowed_paths).toEqual(['src/frontend/checkout/**']);
    expect(backendPayload.denied_tools).not.toEqual(frontendPayload.denied_tools);
    expect(frontendPayload.denied_tools).toEqual(['execute_sql']);
  });

  test('cross-domain reviewer fixture emits clean-context review contract', () => {
    const handoff = buildRuntimeHandoff({
      task_id: 'T3.5-cross-review',
      title: 'Review backend/frontend checkout handshake',
      domains: ['billing', 'checkout-ui'],
      cross_domain: true,
      changed_paths: [
        'src/backend/auth/session.js',
        'src/frontend/checkout/review.tsx',
        'contracts/interfaces/billing-api.yaml'
      ]
    }, {
      targetRole: 'reviewer',
      projectRoot,
      projectConfig,
      secretKey: 'test-secret',
      nowMs: 1741305600000,
      expiresInSeconds: 900
    });

    expect(handoff.payload).toMatchObject({
      task_id: 'T3.5-cross-review',
      target_role: 'reviewer',
      scope_profile: 'fullstack',
      review_only: true,
      risk_level: 'CRITICAL',
      contracts: [
        'contracts/interfaces/billing-api.yaml',
        'contracts/interfaces/checkout-ui-api.yaml'
      ],
      change_summary_limit: 500,
      review_input_mode: 'clean_context'
    });
    expect(handoff.payload.allowed_paths).toContain('tests/**');
    expect(handoff.payload.allowed_paths).toContain('docs/**');
    expect(handoff.payload.prompt_payload.artifact_first).toBe(true);
    expect(handoff.payload.prompt_payload.constraints.review_only).toBe(true);

    expect(handoff.scopedToken.split('.')).toHaveLength(3);
    expect(decodeJwtPayload(handoff.scopedToken)).toMatchObject({
      role: 'reviewer',
      domain: 'cross-domain',
      review_only: true,
      advisory_only: true,
      review_input_mode: 'clean_context'
    });
  });
});
