import { describe, expect, it } from 'vitest';
import {
  appendDeliveryVerificationCriteria, hasExistingDeliveryReadbackStep,
  strengthenDeliveryReadbackSteps, synthesizeDeliveryVerificationGateStep,
} from '../services/workflow/delivery-verification-gate.js';

const publish = { id: 'publish', name: 'Send result', agentId: 'agent-1', dependencies: [], deliveryVerification: 'required' as const };
const readback = { id: 'check', name: 'Check result', agentId: 'agent-1', qaType: 'delivery', dependencies: ['publish'] };

describe('delivery verification topology', () => {
  it('recognizes only a readback downstream of configured delivery', () => {
    expect(hasExistingDeliveryReadbackStep([publish, readback])).toBe(true);
    expect(hasExistingDeliveryReadbackStep([publish, { ...readback, dependencies: [] }])).toBe(false);
    expect(hasExistingDeliveryReadbackStep([publish, { ...readback, qaType: 'semantic' }])).toBe(false);
    expect(hasExistingDeliveryReadbackStep([])).toBe(false);
  });
  it('recognizes transitive downstream readback without cycling forever', () => {
    const bridge = { id: 'bridge', name: 'Bridge', dependencies: ['publish', 'check'] };
    expect(hasExistingDeliveryReadbackStep([publish, bridge, { ...readback, dependencies: ['bridge'] }])).toBe(true);
    expect(hasExistingDeliveryReadbackStep([publish, { ...bridge, dependencies: ['check'] }, { ...readback, dependencies: ['bridge'] }])).toBe(false);
  });
  it('strengthens configured readback only, retaining the existing instructions', () => {
    const steps = strengthenDeliveryReadbackSteps([publish,
      { ...readback, id: 'precheck', dependencies: [], description: 'Before send.' },
      { ...readback, description: 'After send.' },
    ]);
    expect(steps[0].description).toBeUndefined();
    expect(steps[1].description).toBe('Before send.');
    expect(steps[2].description).toContain('After send.');
    expect(steps[2].description).toContain('Delivery Verification:');
    expect(appendDeliveryVerificationCriteria(steps[2].description)).toBe(steps[2].description);
  });
  it('generates explicit delivery QA with the exact publication dependencies', () => {
    const gate = synthesizeDeliveryVerificationGateStep({ dependencyStepIds: ['one', 'two'], agentId: 'agent-1' });
    expect(gate).toMatchObject({ qaType: 'delivery', dependencies: ['one', 'two'], agentId: 'agent-1', graphWorkProductRequired: false });
    expect(hasExistingDeliveryReadbackStep([{ ...publish, id: 'one' }, gate])).toBe(true);
  });
});
