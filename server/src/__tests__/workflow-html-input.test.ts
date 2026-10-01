import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { captureArtifactRoot, digest } from '../services/workflow/artifact-files.js';
import { readHtmlBundle } from '../services/workflow/qa-html-input.js';
import { legacyHtmlManualContract } from './helpers/legacy-html-manual.js';

it.each([legacyHtmlManualContract('check.mjs').bundleManifest!,
  { fileName: 'bundle.json', schemaVersion: 'example.bundle.v2', ancillaryRoles: ['audit'] }])(
  'captures only hash-bound declared HTML assets and ancillary (%s)', async config => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'html-input-')));
  try {
    const root = await captureArtifactRoot(dir), html = Buffer.from('<!doctype html><html></html>'), asset = Buffer.from('image'), meta = Buffer.from('{"ok":false}');
    await mkdir(path.join(dir, 'assets', 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'assets/nested/hero.png'), asset); await writeFile(path.join(dir, 'repo-meta.json'), meta);
    const manifest = { schemaVersion: config.schemaVersion, htmlSha256: digest(html),
      assets: [{ fileName: 'nested/hero.png', sha256: digest(asset), byteSize: asset.length }],
      ancillary: [{ role: config.ancillaryRoles[0], fileName: 'repo-meta.json', sha256: digest(meta), byteSize: meta.length }] };
    const file = path.join(dir, config.fileName); await writeFile(file, JSON.stringify(manifest));
    const read = () => readHtmlBundle(root, path.join(dir, 'index.html'), html, file, config);
    const bundle = await read();
    expect(bundle.assets[0].bytes).toEqual(asset); expect(bundle.ancillary[0].fileName).toBe(config.ancillaryRoles[0]);
    expect(bundle.ancillary[0].bytes).toEqual(meta);
    for (const patch of [{ htmlSha256: '0'.repeat(64) }, { assets: [{ ...manifest.assets[0], fileName: '../outside' }] },
      { ancillary: [{ ...manifest.ancillary[0], fileName: '/tmp/outside' }] }, { schemaVersion: 'wrong.v1' },
      { ancillary: [{ ...manifest.ancillary[0], role: 'undeclared' }] }]) {
      await writeFile(file, JSON.stringify({ ...manifest, ...patch })); await expect(read()).rejects.toThrow();
    }
    await writeFile(file, JSON.stringify(manifest)); await writeFile(path.join(dir, 'repo-meta.json'), '{}');
    await expect(read()).rejects.toThrow('qa_artifact_html_digest_mismatch');
    await rm(path.join(dir, 'repo-meta.json')); await symlink('/etc/passwd', path.join(dir, 'repo-meta.json'));
    await expect(read()).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
