import { constants, createReadStream, readFileSync } from 'node:fs';
import { access, realpath, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Db } from '@paperclipai/db';
import { insertActivityRecord } from '../activity-log-records.js';
import { logger } from '../../middleware/logger.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  byteSize: z.number().int().nonnegative().nullable(), error: z.string().nullable() }).strict();
const coreSchema = z.object({ processId: z.number().int(), processStartedAt: z.string(), hostname: z.string(),
  nodeVersion: z.string(), executablePath: z.string(), entrypoint: z.string().nullable(), observedAt: z.string(),
  files: z.array(fileSchema), loadedBytesAttested: z.literal(false), observation: z.literal('module-initialization-disk-snapshot') }).strict();
export const toolCallProvenanceSchema = z.object({ schemaVersion: z.literal('workflow.tool-call-provenance.v1'),
  companyId: z.string(), toolId: z.string(), toolName: z.string(), requestId: z.string(), workflowRunId: z.string().nullable(),
  stepRunId: z.string().nullable(), stepId: z.string().nullable(), invocationObservedAt: z.string(),
  phase: z.enum(['prepared', 'returned', 'threw']), finishedAt: z.string().nullable(),
  executable: fileSchema, interpreter: fileSchema, toolFiles: z.array(fileSchema), bundleSha256: z.string().nullable(),
  core: coreSchema, loadedBytesAttested: z.literal(false),
  observation: z.literal('pre-invocation-disk-snapshot-not-loaded-module-attestation'),
}).strict();
export type ToolCallProvenance = z.infer<typeof toolCallProvenanceSchema>;
type FileIdentity = z.infer<typeof fileSchema>;
function failure(file: string, error: unknown): FileIdentity {
  return { path: file, sha256: null, byteSize: null, error: String((error as NodeJS.ErrnoException).code ?? 'unavailable') };
}
// Fixed execution boundary, not a recursive source/dependency scan. These are disk
// observations taken when this module initializes, NOT bytes already loaded by V8.
const coreFiles = ['core-tool-executor', 'qa-byte-transport', 'local-tool-progress-executor', 'tool-call-provenance'];
const extension = path.extname(fileURLToPath(import.meta.url));
const core = coreSchema.parse({ processId: process.pid, hostname: hostname(), nodeVersion: process.version,
  processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), executablePath: process.execPath,
  entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : null, observedAt: new Date().toISOString(),
  observation: 'module-initialization-disk-snapshot', loadedBytesAttested: false,
  files: [...coreFiles.map(name => fileURLToPath(new URL(`./${name}${extension}`, import.meta.url))), process.execPath,
    ...(process.argv[1] ? [path.resolve(process.argv[1])] : [])].map(file => {
      try { const bytes = readFileSync(file); return { path: file, sha256: hash(bytes), byteSize: bytes.length, error: null }; }
      catch (error) { return failure(file, error); }
    }),
});
async function identity(file: string): Promise<FileIdentity> {
  try {
    const resolved = await realpath(file), info = await stat(resolved);
    if (!info.isFile()) return failure(resolved, { code: 'not_regular_file' });
    const digest = createHash('sha256'); let size = 0;
    for await (const bytes of createReadStream(resolved)) { digest.update(bytes); size += bytes.length; }
    return { path: resolved, sha256: digest.digest('hex'), byteSize: size, error: null };
  } catch (error) { return failure(file, error); }
}
async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  const candidates = executable.includes('/') ? [path.resolve(cwd, executable)]
    : (env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => path.resolve(cwd, dir, executable));
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return await realpath(file); } catch { /* try next PATH entry */ }
  }
  return executable;
}
async function interpreterIdentity(executable: FileIdentity, cwd: string, env: NodeJS.ProcessEnv) {
  const handle = await open(executable.path, 'r').catch(() => null);
  if (!handle) return executable;
  try {
    const header = Buffer.alloc(512); const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const first = header.subarray(0, bytesRead).toString('utf8').split('\n')[0]!;
    if (!first.startsWith('#!')) return executable;
    const parts = first.slice(2).trim().split(/\s+/);
    const interpreter = parts[0] === '/usr/bin/env' && parts.length === 2 ? parts[1]
      : parts.length === 1 ? parts[0] : undefined;
    return interpreter ? identity(await resolveExecutable(interpreter, cwd, env))
      : failure(executable.path, { code: 'unsupported_shebang_interpreter' });
  } finally { await handle.close(); }
}
export async function captureToolCallProvenance(input: { companyId: string; toolId: string; toolName: string;
  requestId: string; workflowRunId?: string | null; stepRunId?: string | null; stepId?: string | null;
  commandParts: string[]; cwd: string; env: NodeJS.ProcessEnv; deploymentFiles?: string[] }) {
  const files = input.deploymentFiles;
  if (!files?.length) return null;
  const executablePath = await resolveExecutable(input.commandParts[0]!, input.cwd, input.env);
  const toolFiles = await Promise.all(files.map(file => identity(path.resolve(input.cwd, file))));
  const executable = await identity(executablePath);
  const interpreter = await interpreterIdentity(executable, input.cwd, input.env);
  return toolCallProvenanceSchema.parse({ schemaVersion: 'workflow.tool-call-provenance.v1',
    companyId: input.companyId, toolId: input.toolId, toolName: input.toolName, requestId: input.requestId,
    workflowRunId: input.workflowRunId ?? null, stepRunId: input.stepRunId ?? null, stepId: input.stepId ?? null,
    invocationObservedAt: new Date().toISOString(), phase: 'prepared', finishedAt: null,
    executable, interpreter, toolFiles,
    bundleSha256: toolFiles.every(file => file.sha256 !== null)
      ? hash(JSON.stringify(toolFiles.map((file, i) => ({fileName: files[i], sha256: file.sha256, byteSize: file.byteSize})))) : null,
    core, loadedBytesAttested: false, observation: 'pre-invocation-disk-snapshot-not-loaded-module-attestation',
  });
}
/** Append each phase to the existing company-scoped audit log; never used as execution authority. */
export async function recordToolCallProvenance(db: Db, record: ToolCallProvenance | null,
  phase: ToolCallProvenance['phase']) {
  if (!record) return;
  record.phase = phase;
  record.finishedAt = phase === 'prepared' ? null : new Date().toISOString();
  try {
    const details = toolCallProvenanceSchema.parse(record);
    await insertActivityRecord(db, { companyId: record.companyId, actorType: 'system', actorId: 'workflow-tool-executor',
      action: 'workflow.tool_call_provenance', entityType: 'tool', entityId: record.toolId, details });
  } catch (error) {
    // Observability failure must not cause an external-effect tool to be retried.
    logger.warn({ err: error, requestId: record.requestId }, 'tool call provenance audit unavailable');
  }
}
