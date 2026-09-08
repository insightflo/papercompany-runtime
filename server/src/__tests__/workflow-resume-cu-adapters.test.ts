import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile, mkdtemp, realpath, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode, bytes, JSON_CAP, objectKey, parse } from "../services/workflow-resume-cu-contract.js";
import { readRegular, writePrivate } from "../services/workflow-resume-cu-files.js";
import { createCuObjectReader } from "../services/workflow-resume-cu-objects.js";
import { runCuReceiver } from "../services/workflow-resume-cu-process.js";
import { secretService } from "../services/secrets.js";
import { createCompanyWorkProductStorageService } from "../services/company-work-product-storage.js";
import { cuDatabase } from "./workflow-resume-cu-fixture.js";
import { seedCompanyOnly } from "./helpers/workflow-execution-definition-fixture.js";
import { execFileSync } from "node:child_process";

let fixture: Awaited<ReturnType<typeof cuDatabase>>, root: string;
beforeAll(async () => {
  fixture = await cuDatabase(); root = await mkdtemp(path.join(await realpath(tmpdir()), "cu-adapters-"));
}, 120_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); await fixture?.cleanup(); });

test.each(['{"x":1,"x":1}', '{"scope":{"id":1,"id":2}}', '{"x":1e9999}', '{"x":NaN}', '{"x":1} trailing', '{"a":01}'])("strict JSON rejects duplicate/overflow/invalid bytes: %s", raw => {
  expect(() => decode(Buffer.from(raw))).toThrow();
});
test("JSON and snapshot caps apply before parsing, invalid UTF8 rejects", () => {
  expect(() => decode(Buffer.alloc(JSON_CAP + 1))).toThrow("cu_evidence_limit");
  expect(() => bytes({ huge: "a".repeat(JSON_CAP) })).toThrow("cu_evidence_limit");
  expect(() => decode(Buffer.from([0xff]))).toThrow();
});
test.each(["/absolute", "a//b", "a/../b", "a/./b", "a\\b", "a%2fb", "a?x", "a#x", "a\0b"])("rejects nonverbatim object path before reads: %s", key => {
  expect(() => parse(objectKey, key)).toThrow();
});
test("real bounded regular no-follow filesystem reads, immutable writes and private mode", async () => {
  const raw = Buffer.from("original bytes"), file = path.join(root, "regular");
  await writePrivate(file, raw); expect(await readRegular(file, raw.length)).toEqual(raw);
  await expect(readRegular(file, raw.length - 1)).rejects.toThrow("cu_evidence_limit");
  await expect(writePrivate(file, raw)).rejects.toThrow();
  await symlink(file, path.join(root, "linked-file"));
  await expect(readRegular(path.join(root, "linked-file"))).rejects.toThrow();
  await mkdir(path.join(root, "real-dir")); await writeFile(path.join(root, "real-dir", "object"), raw);
  await symlink(path.join(root, "real-dir"), path.join(root, "linked-dir"));
  await expect(readRegular(path.join(root, "linked-dir", "object"))).rejects.toThrow();
  await expect(readRegular(path.join(root, "real-dir"))).rejects.toThrow();
});
test("local object configuration default absent and non-private roots fail closed", async () => {
  const company = await seedCompanyOnly(fixture.sql, "CL" + randomUUID().slice(0, 8));
  delete process.env.PAPERCLIP_CU_LOCAL_OBJECT_ROOT;
  const read = createCuObjectReader(fixture.db);
  await expect(read(company.companyId, "shorts/runs/object")).rejects.toMatchObject({ status: 503 });
  const publicRoot = path.join(root, "public-root"); await mkdir(publicRoot); await chmod(publicRoot, 0o755);
  process.env.PAPERCLIP_CU_LOCAL_OBJECT_ROOT = publicRoot;
  await expect(read(company.companyId, "shorts/runs/object")).rejects.toThrow("cu_evidence_io");
});
test("actual S3 SDK reads configured company secrets, prefixes once, bounds a streaming HTTP body", async () => {
  const { companyId } = await seedCompanyOnly(fixture.sql, "CS" + randomUUID().slice(0, 8));
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = "7".repeat(64);
  const secrets = secretService(fixture.db);
  const access = await secrets.create(companyId, { name: "cu-access", provider: "local_encrypted", value: "fixture-access" });
  const secret = await secrets.create(companyId, { name: "cu-secret", provider: "local_encrypted", value: "fixture-secret" });
  const seen: string[] = [], authorization: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!); authorization.push(req.headers.authorization ?? "");
    res.write(Buffer.alloc(6, "a")); res.end(Buffer.alloc(6, "b"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await createCompanyWorkProductStorageService(fixture.db).save(companyId, { provider: "s3", endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1", bucket: "fixture-bucket", keyPrefix: "private-prefix", forcePathStyle: true,
      accessKeySecretId: access.id, secretAccessKeySecretId: secret.id });
    const read = createCuObjectReader(fixture.db), key = "shorts/runs/exact/object.json";
    expect(await read(companyId, key, 12)).toEqual(Buffer.from("aaaaaabbbbbb"));
    await expect(read(companyId, key, 10)).rejects.toThrow("cu_evidence_limit");
    expect(seen).toHaveLength(2);
    for (const url of seen) expect(url.split("?")[0]).toBe("/fixture-bucket/private-prefix/shorts/runs/exact/object.json");
    expect(authorization[0]).toContain("Credential=fixture-access/");
    // Invalid persisted S3 config must not silently use local mode.
    await fixture.sql`UPDATE company_work_product_storages SET endpoint='not-a-url' WHERE company_id=${companyId}`;
    await expect(read(companyId, key)).rejects.toMatchObject({ status: 503 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("real subprocess bounded combined diagnostics are killed without parsing stdout", async () => {
  const script = path.join(root, "noisy.py");
  await writeFile(script, "import sys\nwhile True: sys.stdout.write('x'*65536); sys.stdout.flush()\n");
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  expect(await runCuReceiver({ python, script, root }, root, "0".repeat(64))).toBe(-1);
});
