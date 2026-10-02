import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildExecutionDefinitionPayload, validateExecutionDefinitionPayload } from '../services/workflow/execution-definition-codec.js';
import { buildWorkflowExecutionSteps } from '../services/workflow/execution-steps.js';
import { isDeliveryReadbackStep } from '../services/workflow/delivery-verification-gate.js';
import { isStructuralGateStep } from '../services/workflow/control-flow/structural-gate.js';
import { planStructuralCompletion, shouldRejectStructuralCallback } from '../services/workflow/control-flow/structural-completion.js';
import { buildQaCapAcceptanceRuntimeContract } from '../services/workflow/control-flow/qa-cap-runtime-contract.js';

const verifierContract = {
  role: 'publication-verify', resultFileName: 'check.json',
  resultSchemaVersion: 'workflow.publication-verification.v1', resultAdapter: 'generic',
  inputParams: {}, consumerParams: { receipt: 'receipt' },
  deploymentFiles: ['run.mjs'], inputEnvelopeVersion: 'input.v1',
};
const verifier = { name: 'neutral-check', adapterConfig: { artifactContract: verifierContract } };
const publish = { id: 'send', name: 'Send', type: 'action', agentId: '', dependencies: [], deliveryVerification: 'required' };
const check = { id: 'check', name: 'Check', type: 'tool', agentId: '', dependencies: ['send'], toolNames: ['neutral-check'] };
const build = (qaType?: string, extra = {}) => buildWorkflowExecutionSteps({ name: 'ordinary', stepsJson: [publish, { ...check, qaType, ...extra }] }, [verifier]);

describe('publication verifier preserves independent QA semantics', () => {
  it.each(['structural', 'semantic', 'custom-check'])('retains explicit %s and recognizes frozen readback without live tools', qaType => {
    const steps = JSON.parse(JSON.stringify(build(qaType)));
    expect(steps).toHaveLength(2);
    expect(steps[1].qaType).toBe(qaType);
    expect(isDeliveryReadbackStep(steps[1])).toBe(true);
    expect(steps[1].description).toContain('Delivery Verification:');
  });
  it('defaults only an undeclared QA type to delivery', () => {
    expect(build()[1].qaType).toBe('delivery');
  });
  it('keeps structural dispatch classification and strict completion checks', () => {
    const gate = build('structural')[1];
    expect(isStructuralGateStep(gate)).toBe(true);
    expect(shouldRejectStructuralCallback(gate, undefined, 'request')).toBe(true);
    expect(shouldRejectStructuralCallback(gate, 'request', 'request')).toBe(false);
    expect(planStructuralCompletion({ step: gate, success: true, data: {} })).toMatchObject({ effectiveSuccess: false, structuralContractFailure: true });
    expect(planStructuralCompletion({ step: gate, success: true, data: { verdict: 'request_changes' } })).toMatchObject({ effectiveSuccess: false, structuralGateRejected: true });
  });
  it('blocks cap acceptance for an explicitly semantic frozen publication verifier', () => {
    const steps = build('semantic');
    steps[0].conditionalDependencies = [{ stepId: 'check', isBackEdge: true, allowCapAcceptance: true, maxIterations: 1, when: 'qa_request_changes' }];
    expect(buildQaCapAcceptanceRuntimeContract({ qaStep: steps[1], qaIssueId: 'issue', steps, stepRuns: [{ stepId: 'send', status: 'completed', iterationIndex: 1 }] })).toBeNull();
  });
  it('validates the frozen role marker and retains the independent QA type', () => {
    const payload = buildExecutionDefinitionPayload({ companyId: randomUUID(), workflowRunId: randomUUID(), executionMode: 'static_dag',
      steps: build('structural'), provenance: { schemaVersion: 1, origin: 'run_creation', workflowId: randomUUID(), missionId: null,
        workflowName: 'ordinary', source: null, sourceKind: null, definitionUpdatedAt: new Date().toISOString() } });
    expect(validateExecutionDefinitionPayload(payload).steps[1]).toMatchObject({ qaType: 'structural', deliveryRole: 'publication-verify' });
    expect(() => validateExecutionDefinitionPayload({ ...payload, steps: [{ ...build('structural')[1], deliveryRole: 'unrecognized' }] })).toThrow();
  });
  it('does not trust caller-supplied derived role or incomplete artifact contracts', () => {
    const steps = buildWorkflowExecutionSteps({ name: 'ordinary', stepsJson: [publish, { ...check, qaType: 'semantic', deliveryRole: 'publication-verify' }] }, [
      { ...verifier, adapterConfig: { artifactContract: { role: 'publication-verify' } } },
    ]);
    expect(steps).toHaveLength(3);
    expect(isDeliveryReadbackStep(steps[1])).toBe(false);
  });
});
