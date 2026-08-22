/**
 * Every HTTP call to Career Caddy goes through here.
 *
 * The legacy extension repeated this header triple at ~28 call sites:
 *
 *     'Content-Type': 'application/vnd.api+json',
 *     Accept: 'application/vnd.api+json',
 *     Authorization: `Bearer ${apiKey}`,
 *
 * One place instead of 28 is the point. WarpDrive's RequestManager does this
 * job too and is the intended destination — this module is deliberately shaped
 * like a handler chain so it can slot in behind these signatures without the
 * call sites changing. Its bundle cost is still unmeasured, and shipping a
 * working extension does not depend on the answer, so it is not blocked on it.
 */

export const ORIGIN = 'https://careercaddy.online';
export const FRONTEND_ORIGIN = 'https://careercaddy.online';

/** Hosts that ARE Career Caddy, as opposed to job boards we scrape. */
export const SELF_HOSTS = new Set(['careercaddy.online', 'www.careercaddy.online']);

const JSON_API = 'application/vnd.api+json';

/**
 * A discriminated union rather than throwing.
 *
 * HTTP failure is an ordinary outcome here, not an exception: an expired key,
 * an offline laptop and a 409-duplicate all need showing to the user, and none
 * of them is a bug. Making the type say "you get data or you get a reason"
 * means the compiler will not let a call site read `.data` without checking.
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON:API document. Serialized here so call sites never touch headers. */
  body?: unknown;
  /** A `jh_*` API key, or a JWT during the connect handshake. */
  token?: string | null;
  /**
   * Some endpoints are plain JSON, not JSON:API — /token/refresh/ and
   * /scrapes/from-text/ among them. They are legitimately RPC-shaped and are
   * staying that way; this flag is how they opt out rather than being wrong.
   */
  plainJson?: boolean;
  /**
   * Send no Content-Type at all. `scrape-profiles/:id/sharpen/` needs this:
   * it takes an empty body, and announcing a content type makes DRF try to
   * parse one. Stamping headers unconditionally reintroduces that bug, which
   * is exactly why this is an explicit option and not an oversight.
   */
  noContentType?: boolean;
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { method = 'GET', body, token, plainJson = false, noContentType = false } = options;

  const headers: Record<string, string> = {};
  if (!noContentType) {
    headers['Content-Type'] = plainJson ? 'application/json' : JSON_API;
  }
  headers['Accept'] = plainJson ? 'application/json' : JSON_API;
  // ONE header, two credential shapes. A JWT and a `jh_*` API key both ride
  // `Authorization: Bearer`; the api tells them apart by the `jh_` prefix.
  // There is no `Api-Key` scheme — sending one returns a 401 whose body reads
  // like an empty result set, which has cost people an hour before.
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, error: describeNetworkError(error) };
  }

  if (response.status === 204) {
    return { ok: true, status: 204, data: undefined as T };
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: describeApiError(response.status, parsed) };
  }
  return { ok: true, status: response.status, data: parsed as T };
}

/**
 * JSON:API puts errors in `errors[]`, but DRF's own exceptions (401, 403,
 * serializer validation) render as a bare `{"detail": "..."}` because the api
 * has no custom EXCEPTION_HANDLER. Both shapes are real; read both.
 */
function describeApiError(status: number, body: unknown): string {
  const doc = body as { errors?: { detail?: string }[]; detail?: string } | undefined;
  const fromErrors = doc?.errors?.[0]?.detail;
  if (fromErrors) return fromErrors;
  if (doc?.detail) return doc.detail;
  if (status === 401 || status === 403) return 'Your Career Caddy session expired.';
  return `Career Caddy returned HTTP ${status}.`;
}

function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not reach Career Caddy: ${message}`;
}

/** Minimal JSON:API document shapes, enough to type the call sites we have. */
export interface JsonApiResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { data?: { type: string; id: string } | null }>;
}
export interface JsonApiDoc<A = Record<string, unknown>> {
  data: JsonApiResource<A>;
  included?: JsonApiResource[];
  meta?: Record<string, unknown>;
}
export interface JsonApiListDoc<A = Record<string, unknown>> {
  data: JsonApiResource<A>[];
  included?: JsonApiResource[];
  meta?: Record<string, unknown>;
}
