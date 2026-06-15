// Auto-generated.
import { API_BASE_URL } from "./config";
import { getLogger } from "../logger";

const log = getLogger("api");

export class ApiError extends Error {
  // `body` retains the parsed error response (an RFC 7807 ProblemDetails on a
  // 422, carrying the per-field `errors[]`) so the form decoder
  // (`applyServerErrors`) can map field errors back onto inputs.
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function rawFetch(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  log.debug(`-> ${method} ${path}`);
  const r = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const ms = Math.round(
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
      startedAt,
  );
  if (!r.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : r.statusText;
    log.warn(`<- ${r.status} ${method} ${path} (${ms}ms): ${message}`);
    throw new ApiError(r.status, message, body);
  }
  log.debug(`<- ${r.status} ${method} ${path} (${ms}ms)`);
  return body;
}

export const api = {
  get: (path: string) => rawFetch(path, { method: "GET" }),
  post: (path: string, body: unknown) =>
    rawFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  delete: (path: string) => rawFetch(path, { method: "DELETE" }),
};
