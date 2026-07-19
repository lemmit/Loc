// Auto-generated.
import { API_BASE_URL } from "./config";
import { getLogger } from "../logger";

const log = getLogger("api");

export class ApiError extends Error {
  status: number;
  // `body` retains the parsed error response (an RFC 7807 ProblemDetails on a
  // 422, carrying the per-field `errors[]`) so the form decoder
  // (`applyServerErrors`) can map field errors back onto inputs.
  body?: unknown;
  // Explicit field declarations + constructor assignments, not
  // parameter properties — the latter is non-erasable sugar Node's
  // type stripping rejects; see src/generator/typescript/emit/value-objects.ts.
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
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
const request = rawFetch;

// Multipart upload variant of `rawFetch`.  Sends a `FormData` body and,
// crucially, does NOT set `content-type` — the browser adds it with the
// generated multipart boundary.  Returns the parsed JSON (a `FileRef`).
async function rawUpload(path: string, form: FormData): Promise<unknown> {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  log.debug(`-> POST ${path} (multipart)`);
  const r = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    body: form,
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
    log.warn(`<- ${r.status} POST ${path} (${ms}ms): ${message}`);
    throw new ApiError(r.status, message, body);
  }
  log.debug(`<- ${r.status} POST ${path} (${ms}ms)`);
  return body;
}

// The wire shape a `File` field / FileUpload primitive round-trips (the
// object-store reference the upload endpoint returns).
export type FileRef = {
  url: string;
  key: string;
  contentType: string;
  size: number;
};

export const api = {
  get: (path: string) => request(path, { method: "GET" }),
  post: (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  upload: (path: string, form: FormData) => rawUpload(path, form),
  // Convenience for the FileUpload primitive: wraps a single File in a
  // FormData (the browser sets the multipart boundary) and POSTs it to the
  // object-store endpoint, returning the FileRef.  Building the FormData here
  // keeps it out of framework template scopes (Vue templates can't reference
  // the FormData global).
  uploadFile: (file: File): Promise<FileRef> => {
    const form = new FormData();
    form.append("file", file);
    return rawUpload("/files", form) as Promise<FileRef>;
  },
  delete: (path: string) => request(path, { method: "DELETE" }),
};
