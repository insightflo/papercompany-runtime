import { expect, it } from 'vitest';
import { freezeArtifactAttempt, readCompletedSourceArtifactAttempt, readFrozenArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';
import { encodeQaInput } from '../services/workflow/qa-byte-transport.js';
import { legacyHtmlManualContract } from './helpers/legacy-html-manual.js';

const contract = legacyHtmlManualContract('check.mjs');
it('freezes preset then step rules and rejects mutated or stale snapshots', () => {
  const config = { ...contract, defaultRules: { rules: { 'tag-count': { params: { min: 2 } } } } };
  const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: config },
    step: { qaConfig: { rules: { 'tag-count': { params: { min: 3 } } } } }, executionGeneration: 2, requestId: 'request' })!;
  config.defaultRules.rules['tag-count'].params.min = 9;
  expect(frozen.qaConfig.rules['tag-count']?.params?.min).toBe(3);
  expect(readFrozenArtifactAttempt(frozen, { executionGeneration: 2, requestId: 'request' })).toEqual(frozen);
  expect(() => readFrozenArtifactAttempt(frozen, { executionGeneration: 3, requestId: 'request' })).toThrow('artifact_contract_snapshot_stale');
  expect(() => readFrozenArtifactAttempt({ ...frozen, contractHash: '0'.repeat(64) })).toThrow('artifact_contract_snapshot_hash');
});
it('fails closed for declared artifact steps without a valid tool contract', () => {
  expect(() => freezeArtifactAttempt({ adapterConfig: {}, step: { toolArtifactContract: { role: 'qa' } },
    executionGeneration: 1, requestId: 'r' })).toThrow('artifact_contract_required');
  expect(freezeArtifactAttempt({ adapterConfig: {}, step: {}, executionGeneration: 1, requestId: 'r' })).toBeNull();
});
it('completed-source fence keeps completed receipts valid across recovery generation bumps', () => {
  const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract }, step: {},
    executionGeneration: 0, requestId: 'dispatch-1' })!;
  // 종결/복구 사이클이 완료 행의 세대를 훨씬 앞으로 올려도 생성 시도의 스냅숏은 소비 가능.
  expect(readCompletedSourceArtifactAttempt(frozen, { executionGeneration: 9, lastDispatchRequestId: 'dispatch-1' })).toEqual(frozen);
  expect(readCompletedSourceArtifactAttempt(frozen, { executionGeneration: 0, lastDispatchRequestId: 'dispatch-1' })).toEqual(frozen);
  // 미래 세대 스냅숏은 절대 받지 않는다.
  const later = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract }, step: {},
    executionGeneration: 2, requestId: 'dispatch-2' })!;
  expect(() => readCompletedSourceArtifactAttempt(later, { executionGeneration: 1, lastDispatchRequestId: 'dispatch-2' }))
    .toThrow('artifact_contract_snapshot_stale');
  // 재발사(발사 권위 교체)는 낡은 스냅숏을 무효화한다.
  expect(() => readCompletedSourceArtifactAttempt(frozen, { executionGeneration: 9, lastDispatchRequestId: 'dispatch-2' }))
    .toThrow('artifact_contract_snapshot_stale');
  // 위변조 해시는 여전히 fail-closed.
  expect(() => readCompletedSourceArtifactAttempt({ ...frozen, contractHash: '0'.repeat(64) },
    { executionGeneration: 9, lastDispatchRequestId: 'dispatch-1' })).toThrow('artifact_contract_snapshot_hash');
});
it('takes envelope version from declaration rather than a producer name', () => {
  expect(JSON.parse(encodeQaInput(Buffer.from('{}'), [], null, undefined, 'example.input.v3').toString()).schemaVersion).toBe('example.input.v3');
});
