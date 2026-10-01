import { requestPublicHttps } from "../public-https-request.js";

/** No redirects/retries: at most 20 unique HTTPS URLs, four workers and 10s total. */
export async function qaLinksReachable(links: string[]): Promise<boolean> {
  const urls = [...new Set(links)];
  if (urls.length > 20) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let next = 0, ok = true;
  try {
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
      while (ok && !controller.signal.aborted) {
        const index = next++;
        if (index >= urls.length) return;
        const result = await requestPublicHttps(urls[index], { signal: controller.signal, headersOnly: true });
        if (!result.ok) { ok = false; controller.abort(); }
      }
    }));
    return ok && !controller.signal.aborted;
  } finally { clearTimeout(timer); }
}
