// A `fetch` implementation backed by the runtime engine's `dispatch`.
//
// The generated e2e suite calls global `fetch` against absolute URLs
// (`http://localhost:8080/products`, …).  In the playground there is
// no network backend — the booted Hono app lives in the runtime
// worker — so we hand the suite this `fetch`, which forwards each
// request through `dispatch` and reconstructs a real `Response`.  The
// runtime matches on the URL pathname, so the host/port in the URL is
// irrelevant (every endpoint resolves to the one booted backend).
//
// Pure (the dispatcher is injected) so it's unit-testable.

import type {
  DispatchResult,
  SerializedRequest,
} from "../runtime/protocol.js";

type Dispatch = (req: SerializedRequest) => Promise<DispatchResult>;

function headersToObject(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    Object.assign(out, init);
  }
  return out;
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function makeDispatchFetch(dispatch: Dispatch): typeof fetch {
  return async function dispatchFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToObject(init?.headers);
    const rawBody = init?.body;
    const body =
      rawBody == null
        ? null
        : typeof rawBody === "string"
          ? rawBody
          : String(rawBody);

    const result = await dispatch({ url, method, headers, body });
    if (!result.ok) {
      // Mirror a network-level failure so the suite's helpers surface a
      // real error rather than a misleading HTTP status.
      throw new TypeError(`runtime dispatch failed: ${result.message}`);
    }
    const r = result.response;
    return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
    });
  } as typeof fetch;
}
