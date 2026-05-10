// Auto-generated.
import { API_BASE_URL } from "./config";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function rawFetch(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : r.statusText;
    throw new ApiError(r.status, message);
  }
  return body;
}

export const api = {
  get: (path: string) => rawFetch(path, { method: "GET" }),
  post: (path: string, body: unknown) =>
    rawFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
};
