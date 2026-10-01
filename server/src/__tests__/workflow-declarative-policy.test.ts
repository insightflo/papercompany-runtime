import { describe, expect, it } from 'vitest';
import { workflowStepDefinitionSchema } from '@paperclipai/shared';
import { classifyWorkflowStepRole } from '../services/workflow-step-role.js';
import { isDeliveryReadbackStep, isDeliveryRelevantStep } from '../services/workflow/delivery-verification-gate.js';
import { buildWorkflowExecutionSteps } from '../services/workflow/execution-steps.js';
import { buildQaCapAcceptanceRuntimeContract } from '../services/workflow/control-flow/qa-cap-runtime-contract.js';

const step = { id: 's1', name: 'Ordinary step', agentId: '', dependencies: [] };
const publisher = { name: 'arbitrary-tool', adapterConfig: { artifactContract: {
  role: 'publication', resultFileName: 'result.json', resultSchemaVersion: 'workflow.publication-result.v1',
  resultAdapter: 'generic', inputParams: { content: 'document' }, deploymentFiles: ['run.mjs'], inputEnvelopeVersion: 'input.v1',
  publication: { identity: { param: 'id' }, bindings: [{ resultPointer: '/date', parameter: 'date' }],
    publishedAt: { resultPointer: '/publishedAt', dateParam: 'date', suffix: 'T00:00:00.000Z' } },
} } };
const verifier = { name: 'arbitrary-check', adapterConfig: { artifactContract: {
  ...publisher.adapterConfig.artifactContract, role: 'publication-verify', publication: undefined,
  consumerParams: { receipt: 'receipt' },
} } };

describe('declarative workflow authority', () => {
  it.each(['manual-onboarding publisher', 'Publish to R2', 'Cloudflare pages deploy', '회사게시', 'website'])('ignores delivery prose: %s', name => {
    expect(isDeliveryRelevantStep({ ...step, name, description: name })).toBe(false);
  });
  it('uses explicit delivery policy and validated selected tool roles, never names or step contract hints', () => {
    expect(isDeliveryRelevantStep({ ...step, deliveryVerification: 'required' })).toBe(true);
    expect(isDeliveryRelevantStep({ ...step, toolNames: ['arbitrary-tool'] }, [publisher])).toBe(true);
    expect(isDeliveryRelevantStep({ ...step, toolNames: ['other'] }, [publisher])).toBe(false);
    expect(isDeliveryRelevantStep({ ...step, toolNames: ['arbitrary-tool'] }, [{ ...publisher, adapterConfig: { artifactContract: { role: 'publication' } } }])).toBe(false);
    expect(isDeliveryRelevantStep({ ...step, toolArtifactContract: { role: 'publication' } })).toBe(false);
  });
  it('uses explicit delivery qaType or selected verifier role only', () => {
    expect(isDeliveryReadbackStep({ ...step, qaType: 'delivery' })).toBe(true);
    expect(isDeliveryReadbackStep({ ...step, toolNames: ['arbitrary-check'] }, [verifier])).toBe(true);
    expect(isDeliveryReadbackStep({ ...step, name: '[QA] public readback HTTP 200 공개검증' })).toBe(false);
  });
  it('injects a gate for configured publication, freezes verification role, and does not duplicate downstream readback', () => {
    const publish = { ...step, toolNames: ['arbitrary-tool'] };
    const built = buildWorkflowExecutionSteps({ name: 'ordinary', stepsJson: [publish] }, [publisher]);
    expect(built).toHaveLength(2);
    expect(built[0]).toMatchObject({ deliveryVerification: 'required' });
    expect(built[1]).toMatchObject({ qaType: 'delivery', dependencies: ['s1'] });
    const existing = buildWorkflowExecutionSteps({ name: 'ordinary', stepsJson: [publish,
      { ...step, id: 's2', toolNames: ['arbitrary-check'], dependencies: ['s1'] }] }, [publisher, verifier]);
    expect(existing).toHaveLength(2);
    expect(existing[1]).toMatchObject({ qaType: 'delivery' });
  });
  it.each(['[QA] final quality check', '[ACTION] produce', '검증', 'Audit report', 'delivery readback'])('ignores free-text role labels: %s', name => {
    expect(classifyWorkflowStepRole({ id: 'arbitrary', name })).toBe('unknown');
  });
  it('does not treat arbitrary IDs as authority and honors explicit type/qaType', () => {
    expect(classifyWorkflowStepRole({ id: 'qa-check' })).toBe('unknown');
    expect(classifyWorkflowStepRole({ type: 'action', name: '[QA] review' })).toBe('action');
    expect(classifyWorkflowStepRole({ qaType: 'semantic' })).toBe('qa');
  });
  it.each([{ deliveryVerification: true }, { deliveryVerification: 'optional' }, { capAcceptance: true }, { capAcceptance: 'allowed' }])('rejects invalid policy %j', policy => {
    expect(workflowStepDefinitionSchema.safeParse({ id: 's', ...policy }).success).toBe(false);
  });
  it('blocks cap contracts explicitly, without matching keywords', () => {
    const qa = { ...step, id: 'q', qaType: 'semantic', name: 'public readback' };
    const producer = { ...step, conditionalDependencies: [{ stepId: 'q', isBackEdge: true, allowCapAcceptance: true, maxIterations: 1, when: 'qa_request_changes' as const }] };
    const input = { qaStep: qa, qaIssueId: 'issue', steps: [producer, qa], stepRuns: [{ stepId: 's1', status: 'completed', iterationIndex: 1 }] };
    expect(buildQaCapAcceptanceRuntimeContract(input)).not.toBeNull();
    expect(buildQaCapAcceptanceRuntimeContract({ ...input, qaStep: { ...qa, capAcceptance: 'blocked' } })).toBeNull();
  });
});
