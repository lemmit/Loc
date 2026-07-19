# M-T1.2 slice 4b — FileUpload cross-frontend fan-out (Vue / Svelte / Angular)

*In-flight. Fans the `FileUpload` input (shipped React-only in slice 4a, #2039)
out to the remaining JSX frontends and flips the required-primitives gate.*

## Scope

The walker emitter (`emitFileUpload`), the validator (`loom.file-upload-not-file-field`),
the in-form `File` arm (`form-fields-vm.ts`, `form-helpers.ts`), and the wire are
already shared/merged. 4b adds the per-framework **pack templates** + **API-client
upload helper** so the two surfaces render on Vue/Svelte/Angular.

- **Vue** (vuetify v3, shadcnVue v1): `field-input-file.hbs` + `primitive-file-upload.hbs`.
- **Svelte** (flowbite v1, shadcnSvelte v1): `field-input-file.hbs` + `primitive-file-upload.hbs`.
- **Angular** (angularMaterial v1, primeng v1, spartanNg v1): `primitive-file-upload.hbs`
  + a `File` arm in `src/generator/angular/form-fields.ts` (Angular forms render inline
  via seams, not `field-input-*` templates).
- **API client**: each framework's generated client needs the multipart `upload`
  helper (React got it in `api/api-client.hbs`); add the framework equivalent.

## The gate flip (only after all packs above carry the templates)

- `TSX_ONLY_PRIMITIVES` += `primitive-file-upload` (required for tsx/svelte/vue/angular).
- `TSX_FIELD_INPUT` += `field-input-file` (required for tsx/svelte/vue).

## Still deferred to a later slice

- **HEEx** `live_file_input`/`allow_upload` — a channel-streamed model, not the
  POST-then-bind flow. `KNOWN_HEEX_GAPS.FileUpload` + `allowlist-ratchet` max=1 stay;
  `FileUpload` stays **out of `showcase.ddd`** (the render matrix drives it through
  HEEx), so the `showcase-completeness` exemption stays (comment updated: "no HEEx
  renderer yet", not "React only").
- **Clickable `FileLink` display primitive** + optional-`File?` display (slice 4a.1
  renders `.url` as text cross-frontend today).

## Gates

`generated-{vue,svelte,angular}-build` on a File-bearing fixture (a scaffolded or
hand-authored `File` form) must `tsc`/`vue-tsc`/`svelte-check`/`ng build` clean per
pack. Mirror `web/src/examples/file-upload-system.ddd`.
