// Test-only transport bridge. The actual tools execute ONLY in network-none Docker.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [script, command, ...args] = process.argv.slice(2);
const tools = path.dirname(script), here = path.dirname(fileURLToPath(import.meta.url));
const bundle = process.env.OVERSIGHT_READER_BUNDLE;
if (!path.isAbsolute(tools) || !bundle || !path.isAbsolute(bundle)) throw Error('Explicit external tool and reader paths required');
const mounts = [tools, here, path.dirname(bundle)];
const cli = ['--context', 'colima-publishing-cms-b1', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m'];
for (const dir of new Set(mounts)) cli.push('-v', `${dir}:${dir}:ro`);
for (const key of ['PAPERCLIP_STEP_OUTPUT_DIR', 'PAPERCOMPANY_QA_INPUT', 'PAPERCOMPANY_QA_RESULT_FD', 'PAPERCOMPANY_PUBLICATION_SCOPE']) {
  if (process.env[key]) cli.push('-e', `${key}=${process.env[key]}`);
}
cli.push('-e', `OVERSIGHT_READER_BUNDLE=${bundle}`, 'node:24.13.0-bookworm', 'node', path.join(here, 'oversight-container-runner.mjs'), script, command, ...args);
const result = spawnSync('docker', cli, { input: fs.readFileSync(0), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 });
if (result.status !== 0) throw Error(`Isolated tool failed: ${result.error ?? result.stderr} ${result.stdout}`);
const output = JSON.parse(result.stdout);
if (output.evidence && process.env.OVERSIGHT_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.OVERSIGHT_EVIDENCE_DIR, 'publication.json'), JSON.stringify(output.evidence, null, 2));
process.stdout.write(output.stdout); process.stderr.write(output.stderr);
fs.writeFileSync(4, output.machineResult);
