import fs from 'fs';
import path from 'path';

/**
 * Direct navigation/refresh to a client-side route (e.g. /dashboard,
 * /stock/INFY) returned Vercel's 404 NOT_FOUND because there was no
 * vercel.json rewrite telling Vercel to fall back to index.html for
 * unmatched paths -- Vercel's static hosting otherwise only serves files
 * that physically exist in the build output. This is a config test, not an
 * integration test: it can't run the Vercel router itself, but it does
 * guard against the rewrite rule being silently removed or narrowed again.
 */
describe('vercel.json SPA rewrite', () => {
  const configPath = path.join(__dirname, '..', '..', 'vercel.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('exists and rewrites every path to index.html', () => {
    expect(Array.isArray(config.rewrites)).toBe(true);
    const catchAll = config.rewrites.find((r) => r.destination === '/index.html');
    expect(catchAll).toBeTruthy();
    expect(catchAll.source).toBe('/(.*)');
  });

  it.each([
    '/dashboard',
    '/earnings',
    '/goals',
    '/stock/INFY',
  ])('%s would match the catch-all rewrite pattern', (route) => {
    const catchAll = config.rewrites.find((r) => r.destination === '/index.html');
    const pattern = new RegExp(`^${catchAll.source}$`);
    expect(pattern.test(route)).toBe(true);
  });
});
