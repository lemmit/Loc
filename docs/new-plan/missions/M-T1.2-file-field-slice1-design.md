# M-T1.2 / M-T4.6 — `File` field type, Slice 1 (Hono + localDisk)

*Status: in-flight. Draft-PR claim for the first slice of the file-upload
vertical. Owner decision (2026-07-18): a deleted `File`-bearing row **leaves
the backing object** — no lifecycle coupling in this slice.*

## Why this slice first

The object-store **plumbing already ships** (`objectStore` dataSource kind,
`s3` storage type, and the `files.put/get/list/signedUrl/delete` verbs
callable from workflow bodies). What's missing is the declarative developer
surface: a **`File` field type**, its **auto-emitted upload/download
endpoints**, a dependency-free **`localDisk`** store, and the **`FileUpload`
page primitive** (M-T1.2).

`File` and its wire shape are load-bearing — the endpoints, the s3 presign
path, and the UI primitive all consume that shape. So Slice 1 defines and
**freezes** it, on one backend, with a dependency-free store, so it runs in
the per-PR behavioural gate rather than nightly-only.

## Scope (Slice 1)

- **Grammar:** `File` field type; `localDisk` added to `StorageType`.
- **Validator:** `loom.file-field-needs-object-storage` — a `File` field on
  an aggregate whose host binds no `objectStore` dataSource is an error.
- **IR + enrich:** `File` folds into `wireShape` as the fixed ref shape
  `{ url, key, contentType, size }`.
- **Hono emit:** `POST /<agg>/upload` (multipart → store under a key on the
  bound localDisk object store → return the ref) and `GET /files/:key`
  (stream the object back); the ref shape in the aggregate `Response`.
- **Tests:** parse, negative validator, Hono generator, one `LOOM_TS_BUILD`
  compile case, and a behavioural round-trip (upload bytes → ref → GET back).

## Frozen wire shape

```
FileRef = { url: string, key: string, contentType: string, size: int }
```

## Deferred to stacked follow-ons

- **Slice 2** — fan `File` wire shape + endpoints to the other four backends.
- **Slice 3** — `s3` presigned upload (wire the shipping `signedUrl` verb to
  `File`); `localDisk` stays the dev default.
- **Slice 4 (= M-T1.2 proper)** — the `FileUpload` page primitive across
  walkers/packs, consuming this frozen shape.
- **Deletion** — object cleanup on row delete / sweep job (owner deferred).
