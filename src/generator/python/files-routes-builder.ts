import { lines } from "../../util/code-builder.js";

/** `app/domain/file_ref.py` — the shared `FileRef` wire/JSONB shape a `File`
 *  field round-trips (M-T1.2).  A `TypedDict` (a plain dict at runtime) so it
 *  stores into a JSONB column with no serde and `Mapped[FileRef]` types the
 *  repository read.  Emitted once per project whenever any hosted aggregate /
 *  value object declares a `File` field; imported as
 *  `from app.domain.file_ref import FileRef`. */
export function renderPyFileRefModel(): string {
  return lines(
    '"""Shared FileRef wire model (M-T1.2).  Auto-generated."""',
    "",
    "from typing import TypedDict",
    "",
    "",
    "class FileRef(TypedDict):",
    '    """The {url, key, contentType, size} an object-store upload returns."""',
    "",
    "    url: str",
    "    key: str",
    "    contentType: str",
    "    size: int",
    "",
  );
}

/** `app/http/files_routes.py` — the app-level File upload/download endpoints
 *  (M-T1.2).  Mounted at the ROOT `/files` (NOT under `/api`) to match the Hono
 *  backend and the frontend api-client (`api.upload("/files", …)` and the
 *  `FileRef.url = "/files/<key>"` download anchor).
 *
 *  `fn` is the bound objectStore resource's snake name; `module` its
 *  `app.resources.<sourceType>` client module — the resource emitter guarantees
 *  `<fn>_put_bytes` / `<fn>_get_bytes` exist there (s3 + localDisk). */
export function renderPyFilesRoutes(fn: string, module: string): string {
  return lines(
    '"""File upload/download endpoints (M-T1.2).  Auto-generated."""',
    "",
    "from uuid import uuid4",
    "",
    "from fastapi import APIRouter, Response, UploadFile",
    "from fastapi.responses import JSONResponse",
    "",
    "from app.domain.errors import AggregateNotFoundError",
    `from ${module} import ${fn}_get_bytes, ${fn}_put_bytes`,
    "",
    'router = APIRouter(prefix="/files", tags=["files"])',
    "",
    "",
    '@router.post("")',
    "async def upload_file(file: UploadFile) -> Response:",
    '    """Multipart upload — store the raw bytes, return a FileRef."""',
    "    key = str(uuid4())",
    "    body = await file.read()",
    '    content_type = file.content_type or "application/octet-stream"',
    `    await ${fn}_put_bytes(key, body, content_type)`,
    "    return JSONResponse(",
    "        {",
    '            "url": f"/files/{key}",',
    '            "key": key,',
    '            "contentType": content_type,',
    '            "size": len(body),',
    "        },",
    "        status_code=201,",
    "    )",
    "",
    "",
    '@router.get("/{key}")',
    "async def download_file(key: str) -> Response:",
    '    """Stream the stored object back with its content-type."""',
    `    obj = await ${fn}_get_bytes(key)`,
    "    if obj is None:",
    // M-T6.39 — raise the app's ONE 404 producer (the `AggregateNotFoundError`
    // handler registered on the FastAPI app) rather than hand-building a body,
    // so an absent object answers the same RFC 7807 envelope — and the same
    // `httpStatus NotFound -> <Code>` override — as every other absent read.
    '        raise AggregateNotFoundError(f"File {key} not found")',
    "    body, content_type = obj",
    "    return Response(content=body, media_type=content_type)",
    "",
  );
}
