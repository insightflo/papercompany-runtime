import type { ArtifactContract } from '@paperclipai/shared';

/** Historical producer dialect, explicitly configured; never inferred from a tool name. */
export function legacyHtmlManualContract(script: string): ArtifactContract {
  return { role: 'qa', resultFileName: 'qa-result.json', resultSchemaVersion: 'manual-onboarding.qa.v1',
    resultAdapter: 'legacy-qa', inputParams: { content: 'content', html: 'html', assetsDir: 'assetsDir', manifest: 'htmlManifest', out: 'out' },
    deploymentFiles: [script], assetDiscovery: ['/blocks/*/assetFile'], inputEnvelopeVersion: 'manual-onboarding.input.v1',
    bundleManifest: { fileName: 'html-input.json', schemaVersion: 'manual-onboarding.html-input.v1',
      ancillaryRoles: ['repoMeta', 'shotResult', 'empiricalResult'] } };
}
export function legacyHtmlManualPublicationContract(script: string): ArtifactContract {
  return { ...legacyHtmlManualContract(script), role: 'publication', resultFileName: 'publication-result.json',
    resultSchemaVersion: 'manual-onboarding.publication.v1', resultAdapter: 'legacy-publication',
    consumerParams: { receipt: 'qaResultPath', content: 'sourceContentPath', html: 'sourceHtmlPath' },
    publication: { identity: { param: 'id', sourcePathParam: 'idSourcePath', sourceFieldParam: 'idSourceField',
      format: 'date-prefixed-slug', dateParam: 'date' }, bindings: [{ resultPointer: '/section', parameter: 'section' },
      { resultPointer: '/date', parameter: 'date', optional: true }],
      publishedAt: { resultPointer: '/publishedAtKst', dateParam: 'date', suffix: 'T00:00:00+09:00' },
      command: 'publish', commandKeySeparator: ':',
      audience: { parameter: 'visibility', privateValue: 'private', privateResult: 'private', defaultResult: 'public' },
      legacyMapping: { fields: { ok: '/ok', command: '/command', mode: '/mode', section: '/section', id: '/id',
        date: '/date', scope: '/scope', title: '/title', publishedAt: '/publishedAtKst', publicUrl: '/publicUrl', cms: '/cms' },
        contentMode: 'content-draft', htmlMode: 'html', contentDigest: '/input/contentSha256', htmlDigest: '/input/htmlSha256',
        qaDigest: '/input/qaSha256', assets: '/input/assetManifest', ancillary: '/input/ancillaryManifest' } } };
}
