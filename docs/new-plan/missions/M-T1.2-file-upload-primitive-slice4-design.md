# M-T1.2 — `FileUpload` UI primitive, Slice 4 (the visible payoff)

*Status: **shipped** — #2039 (slice 4a, React), #2052 (slice 4b, Vue/Svelte/
Angular), #2077 (slice 4c — HEEx `live_file_input` + Feliz Elmish upload +
Angular standalone + the `FileLink` display primitive; all HEEx pins removed).
`FileUpload` now renders on all six frontends and every design pack; the
`required-primitives` gate is flipped (`primitive-file-upload` in
`TSX_ONLY_PRIMITIVES`, `field-input-file` in `TSX_FIELD_INPUT`). Follows the
merged Slice 1 (PR #2007 — the `File` field type + `FileRef` wire contract on
all five backends + `localDisk` + Hono `POST /files`/`GET /files/:key`). Slice 4
was the M-T1.2 headline: an input primitive that lets a user actually upload a
file from a generated form.*

## What it does

A new `FileUpload` input primitive in the page DSL, usable inside a `Form`
bound to a `File` field:

```ddd
Form(of: Attachment) {
  Field(title)
  FileUpload(blob)        // renders a file input; uploads to POST /files; binds the FileRef
}
```

On the frontend it renders a design-pack file `<input type="file">`; on
select it POSTs the file (multipart) to the Slice-1 `POST /files` endpoint,
receives the `FileRef = { url, key, contentType, size }`, and binds that
object into the form value for the `File` field. Submitting the form sends
the `FileRef` as the field value (the wire shape Slice 1 froze).

## Scope (Slice 4)

- Register `FileUpload` in the walker dispatch registry
  (`src/generator/_walker/registry.ts`) + the name-only validator mirror
  (`src/language/walker-stdlib.ts`) — the `walker-stdlib-completeness` gate
  pins the mirror.
- A `tsx` renderer (React first, reference frontend), then fan to the shared
  JSX-family targets (Vue / Svelte / Angular) via `WalkerTarget`.
- Design-pack file-input rendering (mantine first, then the other React
  packs; Vue/Svelte/Angular packs follow).
- HEEx: pinned in `heex-parity` with a reason initially (LiveView upload is a
  different topology — `allow_upload`/`live_file_input`), landed in a
  follow-up — mirroring how Table sort/pagination (M-T1.1) staged HEEx.
- Validator: `FileUpload` must bind a `File`-typed field.

## Follow-ons

- HEEx `live_file_input` upload renderer.
- Wire the `File?` optional (clearable) + multiple-file arrays if the wire
  grows to `File[]`.
- s3 presigned direct-to-bucket upload (pairs with Slice 3).
