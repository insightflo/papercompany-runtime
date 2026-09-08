import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open }));
import { readBoundedJsonFile } from "../services/workflow/control-flow/condition-source-file.js";
afterEach(() => vi.resetAllMocks());
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function descriptor(raw: Buffer, size = raw.length, stride = 3) {
  const close = vi.fn(async () => {});
  const read = vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
    const bytes = raw.subarray(position, position + Math.min(stride, length)); bytes.copy(buffer);
    return { bytesRead: bytes.length };
  });
  open.mockResolvedValue({ stat: async () => ({ size }), read, close });
  return { read, close };
}
test("short position reads hash/parse a single descriptor buffer and always close", async () => {
  const raw = Buffer.from('{ "value":"한글", "number":2.0 }\n');
  const handle = descriptor(raw);
  expect(await readBoundedJsonFile("/fixture", "result", hash(raw))).toEqual({ value: "한글", number: 2 });
  expect(open).toHaveBeenCalledTimes(1);
  expect(handle.read.mock.calls.map(call => call[3])).toEqual(Array.from({ length: Math.ceil(raw.length / 3) + 1 }, (_, i) => Math.min(i * 3, raw.length)));
  expect(handle.close).toHaveBeenCalledTimes(1);
});
test("growth beyond stat cap rejects while reading and closes", async () => {
  const handle = descriptor(Buffer.alloc(1024 * 1024 + 1), 2, 64 * 1024);
  await expect(readBoundedJsonFile("/fixture", "result")).rejects.toThrow("grew beyond");
  expect(handle.close).toHaveBeenCalledTimes(1);
});
test("hash failure closes without a second open or byte read", async () => {
  const handle = descriptor(Buffer.from("{}"));
  await expect(readBoundedJsonFile("/fixture", "result", "0".repeat(64))).rejects.toThrow("verified hash");
  expect(open).toHaveBeenCalledTimes(1); expect(handle.close).toHaveBeenCalledTimes(1);
});
