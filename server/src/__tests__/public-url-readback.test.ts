import { afterEach, expect, it } from 'vitest';
import { isRejectedPublicTitle, readbackPublicUrl, setPublicUrlReadbackFetcher } from '../services/public-url-readback.js';
afterEach(() => setPublicUrlReadbackFetcher(null));
it('rejects declared plain title strings with normalized whitespace', () => {
  expect(isRejectedPublicTitle('<title>  Catalog\n Home </title>', { rejectTitlePatterns: ['Catalog Home'] })).toBe(true);
  expect(isRejectedPublicTitle('<title>Actual article</title><p>Catalog Home</p>', { rejectTitlePatterns: ['Catalog Home'] })).toBe(false);
});
it('does not interpret declared strings as regular expressions or impose a default title', () => {
  expect(isRejectedPublicTitle('<title>Anything</title>', { rejectTitlePatterns: ['.*'] })).toBe(false);
  expect(isRejectedPublicTitle('<title>Catalog Home</title>')).toBe(false);
});
it('applies configured title guard after injected fetch', async () => {
  setPublicUrlReadbackFetcher(async () => ({ ok: true, status: 200, text: '<title>Catalog Home</title>' }));
  expect(await readbackPublicUrl('https://example.org/', { rejectTitlePatterns: ['Catalog Home'] })).toMatchObject({ ok: false, status: 200, error: 'public_readback_title_rejected' });
  expect((await readbackPublicUrl('https://example.org/')).ok).toBe(true);
});
