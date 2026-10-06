import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPaqoWorkflowSteps } from '../services/mission-owner-plan-decisions.js';
import { getStructuralTopologyErrors } from '../services/workflow/control-flow/structural-topology.js';
import { readGeneratedExecutionDescriptionSha } from '../services/workflow/revision-generated-description.js';
import { artifactTools, artifactUnits, paqoDraft, paqoMission } from './helpers/paqo-artifact-tool-fixture.js';

const build = (units = artifactUnits(), tools = artifactTools) => buildPaqoWorkflowSteps(paqoDraft(units), paqoMission, { tools });

describe('PAQO agent artifact tools', () => {
  it('preserves the pre-314 agent shape, references and connected publication replay', () => {
    const steps = build(), [producer, qa, publisher, verifier, finalQa] = steps;
    expect(steps.slice(0, 4).map(s => ({ type: s.type, agentId: s.agentId, required: s.graphWorkProductRequired,
      toolNames: s.toolNames, qaType: s.qaType }))).toEqual([
      { type: 'action', agentId: paqoMission.ownerAgentId, required: true },
      { type: 'action', agentId: paqoMission.ownerAgentId, required: true, toolNames: ['neutral-review'] },
      { type: 'action', agentId: paqoMission.ownerAgentId, required: true, toolNames: ['neutral-release'] },
      { type: 'action', agentId: paqoMission.ownerAgentId, required: true, toolNames: ['neutral-readback'] },
    ]);
    expect(qa.toolArgs).toEqual({ content: `{$steps.${producer.id}.workProductPath}` });
    expect(publisher.toolArgs).toEqual({ qaResultPath: `{$steps.${qa.id}.workProductPath}`, content: `{$steps.${producer.id}.workProductPath}` });
    expect(verifier.toolArgs).toEqual({ receiptInput: `{$steps.${publisher.id}.workProductPath}` });
    expect(steps.filter(s => s.conditionalDependencies?.some(e => e.isBackEdge)).map(s => s.id)).toEqual([publisher.id, verifier.id]);
    for (const s of [publisher, verifier]) expect(s.conditionalDependencies).toContainEqual(expect.objectContaining({ stepId: finalQa.id, isBackEdge: true }));
  });

  it.each(['toolName', 'tools', 'toolNames'])('retains %s aliases and other selected tools for agent use', key => {
    const units = artifactUnits();
    delete units[2].toolNames;
    units[2][key] = key === 'toolName' ? 'neutral-release' : ['neutral-release'];
    units[2].tools = [...(Array.isArray(units[2].tools) ? units[2].tools : []), 'research-workbench-search'];
    expect(build(units)[2]).toMatchObject({ type: 'action', agentId: paqoMission.ownerAgentId });
    expect(build(units)[2].toolNames).toEqual(expect.arrayContaining(['neutral-release', 'research-workbench-search']));
  });

  it('does not restrict an agent unit to a single artifact tool', () => {
    const units = artifactUnits();
    units[2].toolNames = ['neutral-release', 'neutral-review'];
    expect(build(units)[2]).toMatchObject({ type: 'action', toolNames: units[2].toolNames });
  });

  it('preserves explicit QA type, rules, input contract and selector without requiring tool shape', () => {
    const units = artifactUnits();
    units[1].type = 'qa'; units[1].qaType = 'editorial';
    units[1].qaConfig = { rules: { 'required-fields': { enabled: true, params: { pointers: ['/title'] } } } };
    units[1].toolArtifactContract = { role: 'qa', schemaVersion: 'workflow.qa-result.v1', inputStepId: 'build' };
    units[1].workProductSelectors = { build: { type: 'document', title: 'content.json' } };
    const [producer, qa] = build(units);
    expect(qa).toMatchObject({ type: 'qa', agentId: paqoMission.ownerAgentId, qaType: 'editorial', qaConfig: units[1].qaConfig,
      toolArtifactContract: { inputStepId: producer.id }, workProductSelectors: { [producer.id]: { type: 'document', title: 'content.json' } } });
  });

  it('retains explicit structural tool gates and their valid topology', () => {
    const units = artifactUnits();
    units[0].machineChecks = [{ kind: 'file_exists', path: '{$steps.build.workProductPath}' }];
    units[1].type = 'tool'; units[1].qaType = 'structural';
    const steps = build(units), qa = steps.find(s => s.sourceStepId === 'source-review')!;
    expect(qa).toMatchObject({ agentId: '', type: 'tool', qaType: 'structural' });
    expect(getStructuralTopologyErrors(steps)).toEqual([]);
  });

  it('keeps ordinary non-artifact legacy fields byte-identical to pre-314 plus validated additive binding', () => {
    const units = [{ id: 'build', title: 'Build', toolNames: ['search'], toolArgs: { query: 'paper' } },
      { id: 'qa', title: 'Review', type: 'qa', qaType: 'action' }];
    // revisionDescriptionBinding is the single additive key of this revision: project exactly that key
    // away (shallow copy + delete, key order preserved) so the remaining legacy structure still hashes
    // to the original pre-314 guard. No other field is hidden, deleted or weakened.
    type StepMaybeBinding = ReturnType<typeof build>[number] & { revisionDescriptionBinding?: unknown };
    const legacySteps = (steps: ReturnType<typeof build>) => steps.map((step): StepMaybeBinding => {
      const legacy: StepMaybeBinding = { ...step };
      delete legacy.revisionDescriptionBinding;
      return legacy;
    });
    const ordinary = build(units, []);
    expect(createHash('sha256').update(JSON.stringify(legacySteps(ordinary))).digest('hex'))
      .toBe('441d30b6ed8b1b979de959ec2723dea07e004dc639e42c1ea96c00f886b52880');
    expect(JSON.stringify(build(units))).toBe(JSON.stringify(ordinary));
    // Generator-produced action/qa steps must carry a binding that validates via the strict reader;
    // the generator-helper-free mission-final QA step keeps a plain description and is not forced
    // to carry a binding.
    const bound = ordinary.filter((step): step is StepMaybeBinding => 'revisionDescriptionBinding' in step);
    expect(bound.map((step) => step.type)).toEqual(['action', 'qa']);
    for (const step of bound) expect(readGeneratedExecutionDescriptionSha(step)).not.toBeNull();
    const unbound = ordinary.filter((step) => !('revisionDescriptionBinding' in step));
    expect(unbound.map((step) => step.type)).toEqual(['qa']);
    for (const step of unbound) expect(typeof step.description).toBe('string');
  });
});
