import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Reject ULA, link-local, multicast, mapped/compatible IPv4 and transition ranges.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

export interface PublicHttpsResult { ok: boolean; status: number; text: string; error?: string }
interface Options { signal?: AbortSignal; headersOnly?: boolean }

/** Bounded HTTPS GET, one validated/pinned address, original TLS identity, no redirects or credentials. */
export async function requestPublicHttps(url: string, options: Options = {}): Promise<PublicHttpsResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 8000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("public_url_not_safe_https");
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveAddresses(hostname, controller.signal);
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error("public_url_address_blocked");
    if (controller.signal.aborted) throw new Error("public_url_timeout");
    return await new Promise<PublicHttpsResult>((resolve, reject) => {
      const req = request({ hostname: addresses[0].address, port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`, method: "GET", agent: false,
        servername: isIP(hostname) ? undefined : hostname, headers: { Host: parsed.host, "Accept-Encoding": "identity" },
        signal: controller.signal }, response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300 || options.headersOnly) {
          response.destroy();
          resolve({ ok: status >= 200 && status < 300, status, text: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("public_url_response_aborted")));
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy(); req.destroy(); reject(new Error("public_url_body_limit"));
          } else chunks.push(bytes);
        });
        response.on("end", () => resolve({ ok: true, status, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  } catch {
    // Never echo an untrusted URL, credentials, DNS response or remote error into durable diagnostics.
    return { ok: false, status: 0, text: "", error: "public_url_request_failed" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<{ address: string }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([lookup(hostname, { all: true }), new Promise<never>((_, reject) => {
      abort = () => reject(new Error("public_url_dns_aborted"));
      timer = setTimeout(abort, 3000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
