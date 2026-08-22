/**
 * Is this URL something Career Caddy can ingest at all?
 *
 * Mirrors `api/job_hunting/lib/url_policy.py` — defence in depth, fast-failing
 * the obvious cases before a round-trip. **The api remains authoritative**;
 * this exists so the panel can say something useful immediately rather than
 * after a request it already knew would be refused.
 *
 * Pure: no chrome APIs, no DOM, no network. That is what makes it testable,
 * and it is the first module in `domain/` for exactly that reason.
 */

export const SELF_HOSTS = new Set(['careercaddy.online', 'www.careercaddy.online']);

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.localhost'];

/**
 * A discriminated union: `ok: true` carries nothing to explain, `ok: false`
 * always carries a message. The type makes "refused without saying why"
 * unrepresentable rather than merely discouraged.
 */
export type UrlVerdict = { ok: true } | { ok: false; message: string };

export function classifyUrl(rawUrl: string): UrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, message: "This page's URL couldn't be parsed." };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      message: `This page uses ${parsed.protocol} — only http and https can be sent.`,
    };
  }

  const host = parsed.hostname.toLowerCase();

  if (SELF_HOSTS.has(host)) {
    return { ok: false, message: 'This page is on Career Caddy itself — nothing to ingest.' };
  }

  if (host === 'localhost' || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, message: `${host} is private/internal and can't be ingested.` };
  }

  return { ok: true };
}
