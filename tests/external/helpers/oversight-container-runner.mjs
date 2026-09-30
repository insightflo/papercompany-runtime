// External acceptance fixture: CMS/D1/R2 storage are doubles; tools and reader are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const [script, command, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0), decoded = JSON.parse(input);
const hash = b => createHash('sha256').update(b).digest('hex');
const root = fs.mkdtempSync('/tmp/oversight-native-');
const env = { ...process.env, MANUAL_ONBOARDING_WORK_PRODUCT_ROOT: root, PAPERCLIP_WORK_PRODUCT_ROOT: root,
  MANUAL_ONBOARDING_ROOT: root, MANUAL_ONBOARDING_PUBLIC_ROOT: root,
  MANUAL_ONBOARDING_CMS_ENV: path.join(root, 'absent-env'), MANUAL_ONBOARDING_CMS_STATE: path.join(root, 'state.json') };
async function invoke(file, cmd, argv, localEnv, bytes) {
  const child = spawn(process.execPath, [file, cmd, ...argv], { env: localEnv, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] });
  let stdout = '', stderr = '', machineResult = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.stdio[4].on('data', c => machineResult += c); child.stdin.end(bytes);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stdout + stderr); return { stdout, stderr, machineResult };
}
let server;
try {
  if (command === 'qa') {
    console.log(JSON.stringify(await invoke(script, command, args, env, input)));
  } else {
    assert.equal(command, 'publish');
    const worker = (await import(pathToFileURL(process.env.OVERSIGHT_READER_BUNDLE))).default;
    const { publicationFixture } = await import(pathToFileURL(path.join(path.dirname(script), 'tests/cms-service-fixture.mjs')));
    const publication = publicationFixture(), puts = [], ingests = [];
    let content, renderedHtml, releaseManifest;
    async function render() {
      const text = JSON.stringify(content);
      const storage = { ROUTING_SCOPE: 'structured', PUBLIC_ORIGIN: base,
        RELEASE: { prepare: sql => ({ bind: () => ({ run: async () => {
          assert.match(sql, /INSERT INTO article_views/); return { success: true };
        }, first: async () => {
          assert.match(sql, /FROM public_index pi/);
          return {content_id: content.contentId, release_id: 'r1', current_release_id: 'r1', public: 1, presentation: 'reader-1',
            manifest_json: JSON.stringify(releaseManifest)};
        } }) }) }, STORE: { get: async key => {
          assert.equal(key, 'content/r1.json'); return {size: Buffer.byteLength(text), text: async () => text};
        } } };
      const response = await worker.fetch(new Request(`${base}/public/tech-blog/${content.contentId}`), storage);
      assert.equal(response.status, 200); renderedHtml = await response.text(); return renderedHtml;
    }
    server = createServer(async (req, res) => {
      try {
        if (publication.get(req, res)) return;
        if (req.method === 'GET' && req.url === '/public/catalog.json') {
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({sections: ['tech-news','tech-scout','manuals','concepts','tech-blog'].map(key => ({key,articles:[{slug:content.slug,title:content.title,publishedAt:'2026-10-01T10:00:00Z'}]}))}));
        }
        if (req.method === 'GET' && req.url === `/public/tech-blog/${content?.contentId}`) return res.end(await render());
        if (req.method === 'GET') { res.statusCode = 404; return res.end(); }
        const chunks = []; for await (const c of req) chunks.push(c);
        const bytes = Buffer.concat(chunks); res.setHeader('content-type', 'application/json');
        if (req.method === 'PUT') { puts.push(bytes); return res.end('{}'); }
        if (req.url === '/cms-api/ingest/articles') {
          const body = JSON.parse(bytes); ingests.push(body); content = body.content;
          return res.end(JSON.stringify(publication.ingest(content)));
        }
        if (req.url === '/commands') { releaseManifest = JSON.parse(bytes).assets; publication.applied(); return res.end(JSON.stringify({result:{status:'applied'}})); }
        res.statusCode = 404; res.end();
      } catch (e) { res.statusCode = 500; res.end(String(e)); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(env, { CMS_INGEST_TOKEN: 'test-only', CMS_RELEASE_TOKEN: 'test-only', CMS_HOST: '127.0.0.1', CMS_PORT: String(server.address().port),
      CMS_RELEASE_TARGET_URL: base, MANUAL_ONBOARDING_PUBLIC_ORIGIN: base, MANUAL_ONBOARDING_CMS_CATALOG_ORIGIN: base,
      MANUAL_ONBOARDING_PAGES_ORIGIN: base + '/onboarding', MANUAL_ONBOARDING_R2_PUBLIC: base,
      MANUAL_ONBOARDING_VERIFY_ATTEMPTS: '1', MANUAL_ONBOARDING_VERIFY_DETAIL_ATTEMPTS: '1' });
    for (const key of ['CMS_RELEASE_TARGET_URL','MANUAL_ONBOARDING_PUBLIC_ORIGIN','MANUAL_ONBOARDING_CMS_CATALOG_ORIGIN','MANUAL_ONBOARDING_PAGES_ORIGIN','MANUAL_ONBOARDING_R2_PUBLIC']) assert.equal(new URL(env[key]).hostname, '127.0.0.1');
    const output = await invoke(script, command, args, env, input);
    assert.equal(ingests.length, 1); assert.equal(puts.length, decoded.assets.length);
    assert.equal(content.title, JSON.parse(Buffer.from(decoded.content.base64, 'base64')).title);
    assert.deepEqual(puts.map(hash), decoded.assets.map(a => a.sha256));
    const published = JSON.parse(output.stdout), publishFile = path.join(root, 'publish.json');
    fs.writeFileSync(publishFile, JSON.stringify(published));
    const verifyEnv = { ...env, PAPERCLIP_STEP_OUTPUT_DIR: root };
    delete verifyEnv.PAPERCOMPANY_QA_INPUT; delete verifyEnv.PAPERCOMPANY_QA_RESULT_FD;
    const verify = await invoke(script, 'verify', ['--section','tech-blog','--id',content.contentId,'--publish-result-path',publishFile,'--expected-date','2026-09-30'], verifyEnv, undefined);
    assert.equal(JSON.parse(verify.stdout).ok, true);
    output.evidence = { network: 'none', inputSha256: decoded.content.sha256, qaSha256: decoded.qa.sha256,
      putSha256: puts.map(hash), ingestCount: ingests.length, publishedContent: content,
      readerHtmlSha256: hash(renderedHtml), readerBundleSha256: hash(fs.readFileSync(process.env.OVERSIGHT_READER_BUNDLE)), verifier: JSON.parse(verify.stdout),
      substitutes: ['CMS publication HTTP store', 'reader D1/R2 storage'], actual: ['QA CLI (preceding call)', 'publisher CLI', 'reader route/parser/renderer', 'verifier CLI'] };
    console.log(JSON.stringify(output));
  }
} finally { if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive:true,force:true}); }
