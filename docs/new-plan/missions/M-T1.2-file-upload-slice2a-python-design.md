# M-T1.2 slice 2a — File upload/download endpoints on Python/FastAPI

*In-flight. Slice 4 (the `FileUpload` UI primitive, all six frontends) shipped;
the frontend POSTs the file to `POST /files` and binds the returned `FileRef`.
On Hono that endpoint exists (Slice 1); on the other four backends it does not,
so a `File`-bearing app served by a `platform: python|java|dotnet|elixir`
deployable 404s the upload at runtime. Slice 2 fills that gap backend-by-backend;
**2a is Python** — the host-verifiable leg (`uv sync` + ruff + mypy --strict +
pytest), and the reference the other three stack on.*

## The gap

`validateFileFieldObjectStorage` (`loom.file-field-needs-object-storage`) allows
a `File` field on **any** backend that binds an `objectStore` dataSource — it is
not platform-restricted. But only the Hono backend emits the app-level upload/
download endpoints (`src/generator/typescript/emit/routes.ts` → `POST /files` +
`GET /files/:key`, wired to `<res>$putBytes` / `<res>$getBytes`). The Python
resource layer today emits only the **JSON-oriented** resource verbs
(`<fn>_put(key, body)` / `<fn>_get(key)` — `json.dumps`ed) and has **no
`localDisk` adapter** at all, so there is nothing to serve raw bytes with a
content-type.

## Scope (2a)

Mirror the Hono contract (`$putBytes(key, bytes, contentType)` /
`$getBytes(key) -> {body, contentType, size} | None`) on Python:

1. **Bytes adapter — s3** (`src/generator/python/resource-clients.ts`): add
   `<fn>_put_bytes(key, body: bytes, content_type: str)` (S3 `put_object` with
   the raw `Body`+`ContentType`) and `<fn>_get_bytes(key) -> tuple[bytes, str] | None`
   (`get_object` → `(bytes, ContentType)`), alongside the existing JSON verbs.
2. **Bytes adapter — localDisk** (new `PyResourceAdapter`): a dependency-free
   `pathlib`-backed store writing `<dir>/<key>` + a `<key>.meta.json` sidecar for
   the content-type — the Python twin of `localDiskResourceAdapter`
   (`src/platform/hono/v4/adapters/resource-clients.ts`).
3. **Endpoints** (`src/generator/python/…` route/app emitter): `POST /files`
   (FastAPI `UploadFile` → mint uuid key → `put_bytes` → return the `FileRef`
   `{url,key,contentType,size}`, 201) + `GET /files/{key}` (`get_bytes` →
   `Response(bytes, media_type=contentType)`, 404 when absent). Gated on the
   deployable actually hosting a File field + binding an objectStore, so a
   File-free project stays byte-identical.
4. **Selection**: compute the bound objectStore dataSource + its storage `type`
   in the Python app emitter (mirror `src/platform/hono/v4/emit.ts:623`), thread
   it into the route emit.

## Gates

- Fast-suite generator test asserting the emitted `/files` route + the s3/localDisk
  bytes functions (+ a byte-identical negative for a File-free model).
- `LOOM_PYTHON_BUILD=1 npm run test:python` on a File-bearing fixture (localDisk):
  `uv sync` + `ruff` + `mypy --strict` + `pytest` clean.

## Stacked follow-ons (own slices)

- 2b .NET / ASP.NET (Minimal API `/files` + bytes adapter; docker `dotnet build`).
- 2c Java / Spring (`@RestController` + bytes adapter; docker gradle).
- 2d Elixir / Phoenix (`Plug`/controller + bytes adapter; docker `mix compile`,
  `LOOM_HEX_MIRROR`).
- Slice 3 (s3 **presigned** direct-to-bucket) and File-delete cleanup stay
  owner-deferred.
