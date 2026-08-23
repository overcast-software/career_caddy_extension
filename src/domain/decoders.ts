/**
 * Apply-URL decoders, by NAME.
 *
 * The api ships a decoder *name* on a ScrapeProfile — `"linkedin_safety_go"` —
 * and this registry maps it to a function. It never ships the function.
 *
 * That is a hard rule, not an implementation detail. An extension that
 * executes code fetched from a server is a remote-code-execution vector, and
 * both stores treat it as grounds for removal regardless of whose server it
 * is. Names are data; functions are not. If a host needs a decoder that does
 * not exist here, it ships in the next extension release — which is precisely
 * the review step the rule exists to preserve.
 *
 * An unknown name falls back to `passthrough` rather than failing, so an api
 * that learns a new decoder before the extension does degrades to "resolve the
 * href" instead of breaking the send.
 */

export type DecoderName = 'linkedin_safety_go' | 'passthrough';

type Decoder = (href: string, baseHref: string) => string | null;

const DECODERS: Record<string, Decoder> = {
  /**
   * LinkedIn wraps outbound apply links in `/safety/go?url=<real destination>`.
   * Storing the wrapper as the apply_url means the real ATS URL never reaches
   * dedupe — the same posting on Greenhouse would look like a different job.
   */
  linkedin_safety_go: (href, baseHref) => {
    try {
      const parsed = new URL(href, baseHref);
      if (
        parsed.hostname.endsWith('linkedin.com') &&
        parsed.pathname.startsWith('/safety/go')
      ) {
        return parsed.searchParams.get('url') || null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  },

  /** Resolve relative to the page and otherwise leave it alone. */
  passthrough: (href, baseHref) => {
    try {
      return new URL(href, baseHref).toString();
    } catch {
      return null;
    }
  },
};

export function decodeApplyUrl(
  name: string | null | undefined,
  href: string,
  baseHref: string,
): string | null {
  const decoder = (name && DECODERS[name]) || DECODERS['passthrough'];
  return decoder ? decoder(href, baseHref) : null;
}

export function knownDecoder(name: string): boolean {
  return name in DECODERS;
}
