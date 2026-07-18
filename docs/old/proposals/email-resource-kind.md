# Plan: `email` as a resource kind (M-T4.6)

**Status:** Draft / Proposed. Implementation plan for the `email` slice of
mission **M-T4.6** ([`docs/new-plan/T4-eventing-temporal.md`](../../new-plan/T4-eventing-temporal.md)) —
"Day-one batteries: `job`, `email`, object `storage`."

**Scope:** transactional email as a first-class **resource kind**, consumed
from workflow bodies through a closed verb (`mail.send(...)`), realized on all
five backends behind three sourceTypes (`smtp` / `ses` / `sendgrid`). This is a
strictly-additive extension of the shipped resource model
([`resource-model-and-source-types.md`](./resource-model-and-source-types.md)) and
its workflow-consumption surface
([`workflow-resource-consumption.md`](./workflow-resource-consumption.md)) — it
adds *one new kind*, a sibling to `objectStore`/`queue`/`api`, and reuses their
entire pipeline (lowering, need-derivation, interface selection, resource-op
validation, and the generic call-site rendering) unchanged.

It **supersedes** the earlier system-scope sketch (`quickstart-and-day-one-
batteries.md` §5.2, an `email { provider: smtp, from: … }` block emitting a
global `sendEmail(...)`). That block was never built; the resource-model era
makes email a `resource`, not a bespoke system declaration — same call
ergonomics, one fewer grammar construct, and free reuse of the capability-gap /
interface-selection machinery.

---

## 1. Surface design

```ddd
storage mailServer { type: smtp, config: { from: "no-reply@acme.test" } }

resource mail { for: Sales, kind: mailer, use: mailServer }

workflow NotifyPlaced(order: Order id) {
  let o = Order.byId(order)
  mail.send(o.customerEmail, "Order received", "Thanks — order " + o.id + " is in.")
}
```

- **Kind literal:** surface `kind: mailer`, reasoned about internally as a new
  coarse infra kind `email` (§3.5 of the resource RFC) — see the decision below.
- **sourceTypes:** `smtp` | `ses` | `sendgrid` (new `type:` literals). `postmark`
  is a trivial later addition (registry + adapter arm only).
- **Verb vocabulary (v1):** a single verb —
  `send(to: string, subject: string, body: string) → void`, capability `send`.
  Plain-text body; **templated / HTML / multi-recipient email are deferred**
  (see §7).
- **Config:** `from` (required, string) on every mailer sourceType; `region`
  (ses); credentials are **env-bound at runtime, never written into generated
  source** (`SMTP_URL` / `SES_*` / `SENDGRID_API_KEY`), the same discipline the
  s3/rabbitmq adapters already use.

### The one real decision — the surface `kind:` literal is `mailer`, not `email`

`email` is one of the most common domain identifiers in the corpus. Grammar-wise
a `kind:` value literal becomes a **global keyword token**, and `email` collides
in *two* positions:

- **Field name** — `Property.name` is `ID | CommonSoftKeywords`
  (`ddd.langium:1649`); 39 `email: string` fields exist. *Fixable* by adding
  `email` to `CommonSoftKeywords`.
- **Bare expression reference** — the ubiquitous
  `find byEmail(email: string): Customer? where this.email == email` pattern
  (storefront, banking, dotnet-backend, crm, … — many files) uses a
  **`NameRefIdent`** for the trailing `email`. `NameRefIdent` does **not** admit
  soft keywords, so this **cannot** be rescued by soft-keywording — only by
  widening `NameRefIdent` itself, which would let *any* keyword be a bare
  expression reference and undermine the grammar's core discrimination. Not worth
  it for one kind literal.

A corpus grep confirmed the second collision is real and widespread. Therefore:

**Decision — surface `kind: mailer`, internal infra kind `email`.** `mailer`
collides with nothing in the corpus; it maps to the coarse infra kind `email` via
`SURFACE_KIND_MAP` (`mailer: { infraKind: "email" }`), so the mission's "email
resource" intent holds while the user-facing keyword stays collision-proof —
exactly the surface/infra split the resource RFC already uses (`state`→`database`).
Add `'mailer'` to `DataSourceKind` and, defensively, to `CommonSoftKeywords`
(consistent with `objectStore`/`queue`). The resource is conventionally named
`mail` (`resource mail { kind: mailer, … }` → `mail.send(...)`).

The rest of this plan uses `kind: mailer` / infra kind `email`.

---

## 2. Why this is mostly "add a row"

The resource model already generalized every layer to be **kind-agnostic**. The
following need **no email-specific edit** — they widen automatically once the
type unions + registry + verb table know about email, and only their *tests*
grow:

- **Lowering** — bare-name→`refKind:"resource"` (`lower-expr.ts:1360-1375`),
  `.verb(args)`→`callKind:"resource-op"` (`lower-expr.ts:620-643`), the
  statement-position resource-call (`lower-workflow.ts:805-834`), and the
  per-context resource env (`lower.ts:1024-1036`) are all keyed off the generic
  `DataSourceKind` + `findVerb`.
- **Need derivation** — `deriveNeeds` (`enrichments.ts:271-318`) unions
  `resourceOp.capability` per kind generically; `mail.send` auto-derives a
  `send`-capability need.
- **Interface selection** — `deriveResourceInterfaces` (`enrichments.ts:242-254`)
  → `defaultInterfaceFor` picks the interface from the registry.
- **Resource-op validators** — `loom.resource-verb-invalid` +
  `loom.resource-op-in-transaction` (`checks/workflow-checks.ts:911-935`) and the
  capability gap `loom.resource-missing-capability`
  (`checks/system-checks.ts:1954-1979`) fire off the registry/verb table with no
  new code. *(Note: these are the codes that actually ship — the RFC's
  `resource-out-of-scope` / `-unknown-verb` / `-capability-gap` / `-arg-type`
  names are aspirational and not what's in the tree.)*
- **Call-site rendering — the big one.** All five backends dispatch a
  `resource-op` **generically by verb name**, no per-verb switch anywhere:
  - TS: `(await ${resourceName}$${verb}(args))` (`typescript/render-expr.ts:490`)
  - .NET: `${cls}.${resource}${UpperFirst(verb)}(args)` (`dotnet/render-expr.ts:714`)
  - Java: same shape (`java/render-expr.ts:714`)
  - Python: `python/render-expr.ts:529`
  - Phoenix: `${mod}.${resource}_${verb}(args)` (`elixir/render-expr.ts:939`)

  So `mail.send(...)` renders correctly the instant the adapter emits a
  `mail$send` / `mailSend` / `mail_send` helper. **No render-expr change on any
  backend.**

The actual work is therefore concentrated in: the type unions, the registry, the
verb table, five adapter files, one compose arm, and tests.

---

## 3. Change set

### 3.1 Grammar — `src/language/ddd.langium`
1. `DataSourceKind` (`:342-344`) — add `'mailer'`.
2. `StorageType` (`:545-551`) — add `'smtp' | 'ses' | 'sendgrid'`.
3. Soft-keyword arms (`:1785-1786`, etc.) — add `'mailer'` to `CommonSoftKeywords`
   defensively (consistent with `objectStore`/`queue`). `smtp`/`ses`/`sendgrid`
   follow the `s3`/`rabbitmq`/`restApi` precedent of **not** being soft-keyworded
   (they never appear in an identifier position). *No `NameRefIdent` change — that
   collision (`email`) is the reason the kind is `mailer`, §1.*
4. `npm run langium:generate` → commit the regenerated
   `src/language/generated/{ast,grammar}.ts` (guarded by `langium-generated.yml`).
   Update the VS Code TextMate grammar `vscode/grammars/ddd.tmLanguage.json` if it
   enumerates storage types.

### 3.2 IR type unions — `src/ir/types/loom-ir.ts`
- `DataSourceKind` (`:2838`) — add the kind.
- `StorageKind` (`:2279`) — add `"smtp" | "ses" | "sendgrid"`.
- `LoomInterface` (`:2851`) — **decision:** model smtp over a new `"smtp"`
  interface, ses/sendgrid over `"sdk"` (or `"rest"`). Interface is *not*
  load-bearing here (single verb, no per-verb override), so `"sdk"` uniformly is
  acceptable and touches nothing — recommend uniform `"sdk"` for v1, add `"smtp"`
  only if a later slice needs interface-directed emission.

### 3.3 Registry — `src/util/source-types.ts` (the hub)
- `InfraKind` (`:38`) — add `"email"`.
- `SURFACE_KIND_MAP` (`:76-88`) — `mailer: { infraKind: "email" }` (the
  surface→infra map; note the key is the surface literal, the value the infra
  kind).
- `seedBuiltins()` (`:131-207`) — three `registerSourceType` descriptors mirroring
  the `s3` block (`:170-183`):
  ```ts
  registerSourceType({
    name: "smtp",
    supports: { email: { capabilities: set("send"), interfaces: set("sdk") } },
    configKeys: [{ name: "from", type: "string", required: true }],
  });
  registerSourceType({
    name: "ses",
    supports: { email: { capabilities: set("send"), interfaces: set("sdk") } },
    configKeys: [
      { name: "from", type: "string", required: true },
      { name: "region", type: "string" },
    ],
  });
  registerSourceType({
    name: "sendgrid",
    supports: { email: { capabilities: set("send"), interfaces: set("sdk") } },
    configKeys: [{ name: "from", type: "string", required: true }],
  });
  ```
  All lookups (`supportsSurfaceKind`, `capabilitiesFor`, `interfacesFor`,
  `defaultInterfaceFor`, `INTERFACE_PREFERENCE`) then serve email with no further
  edit (add `"smtp"` to `INTERFACE_PREFERENCE` only if that interface is added).

### 3.4 Verb table — `src/ir/resource-verbs.ts`
Add one row to `RESOURCE_VERBS` (`:42`):
```ts
{
  kind: "mailer",           // the surface DataSourceKind (as objectStore/queue/api are)
  verb: "send",
  capability: "send",
  params: [
    { name: "to", type: "string" },
    { name: "subject", type: "string" },
    { name: "body", type: "string" },
  ],
  result: "void",
},
```
`findVerb`/`verbsForKind` then feed lowering, validation, and diagnostics.
No `VerbType` change (all params are `string`).

### 3.5 Per-backend adapters — five files
Each gets a `smtp`/`ses`/`sendgrid` `ResourceAdapter` (`supportedKinds:
["email"]`, `emitProjectDeps`, `emitClientModule` emitting a per-resource `send`
helper), registered in that backend's `ADAPTERS` array + `…ResourceAdapterFor`
lookup. Model on the hono/v4 s3 adapter (`resource-clients.ts:31-123`).

| Backend | File | Client lib (smtp / ses / sendgrid) | Helper emitted |
|---|---|---|---|
| hono v4 (+v5 delegates via `makeHonoPlatform`) | `src/platform/hono/v4/adapters/resource-clients.ts` | `nodemailer` / `@aws-sdk/client-ses` / `@sendgrid/mail` | `${mail}$send(to, subject, body)` |
| .NET | `src/generator/dotnet/adapters/resource-clients.ts` | `MailKit` / `AWSSDK.SimpleEmailV2` / `SendGrid` | `${Resource}Send(...)` |
| Java/Spring | `src/generator/java/adapters/resource-clients.ts` | `spring-boot-starter-mail` / AWS SDK v2 `ses` / `sendgrid-java` | `${resource}Send(...)` |
| Python/FastAPI | `src/generator/python/resource-clients.ts` | `aiosmtplib` / `boto3` (ses) / `sendgrid` | `${resource}_send(...)` |
| Phoenix/Elixir | `src/generator/elixir/adapters/resource-clients.ts` | **Swoosh** (one dep; SMTP/SES/SendGrid are built-in Swoosh adapters — cleanest fit) | `${Mod}.${resource}_send(...)` |

The orchestrator emit/writer wiring (`hono/v4/emit.ts:809`,
`dotnet/index.ts:607`, `java/adapters` writer `:281`, `python/index.ts:148`,
`elixir/dispatch-emit.ts:20`) already routes any registered adapter — new
sourceTypes flow through once they're in the `ADAPTERS` array. Stack/dep blocks
pick up `emitProjectDeps` automatically (the same path s3's `@aws-sdk` deps take).

### 3.6 Compose sidecar — `src/system/index.ts`
`renderStorageSidecars` (`:770-802`) — add an arm:
- `type: smtp` → a dev SMTP catch-all service (**Mailpit**, `axllent/mailpit`,
  SMTP `1025` / UI `8025`) so the quick-start app sends mail with zero real
  credentials, mirroring minio-for-s3.
- `type: ses` / `sendgrid` → **no sidecar** (cloud SaaS, env-configured) — the
  `restApi` precedent (SaaS sourceType emits no service).
Gate byte-identical: models with no mailer storage emit no new service.

---

## 4. Validation behavior (mostly free)
Once §3.3–3.4 land, the existing checks cover email with no new code:
- unknown verb (`mail.frobnicate(…)`) → `loom.resource-verb-invalid`.
- `mail.send` inside a `transactional(…)` span → `loom.resource-op-in-transaction`
  (email can't roll back with the DB tx — points at the outbox pattern).
- a mailer bound to a non-email sourceType (`kind: email, use: <postgres>`) →
  the AST datasource check (`validators/datasource.ts:30-46`) rejects it via
  `supportsSurfaceKind`.
- capability gap → `loom.resource-missing-capability` (dormant unless a sourceType
  omits `send`).

Add only: negative parse/validator tests asserting these fire for email (§6).

---

## 5. Docs to update
`docs/resources.md`, `docs/language-reference/14-apis-storage-resources-channels.md`,
`docs/language-reference/13-workflows.md`, `docs/generators.md`, and the M-T4.6
mission line + this plan's link in `docs/new-plan/T4-eventing-temporal.md`.

## 6. Tests (per layer — extend, don't invent new suites where one exists)
- **Registry:** `test/util/source-types.test.ts` — smtp/ses/sendgrid support the
  `email` kind + `send` capability; non-email types don't.
- **Grammar/parse:** parsing test for `kind: email` + `type: smtp|ses|sendgrid`;
  the `keyword-identifier-*` snapshot updates; a regression asserting an `email:
  string` field **still parses** (option A guard).
- **IR:** `test/ir/resource-kinds.test.ts`, `test/ir/resource-ops.test.ts` —
  `mail.send` lowers to `resource-op`, derives a `send` need, resolves an
  interface.
- **Validation:** negative cases for the four checks in §4.
- **Per-backend generator:** `hono-resource-clients.test.ts` /
  `hono-resource-ops*.test.ts`, `python-resources.test.ts`,
  `generator-java-resources.test.ts`, `dotnet-resource-ops.test.ts`,
  `phoenix-resource-ops.test.ts` — assert each adapter emits the `send` helper +
  the client dep, and that `mail.send(...)` renders the call.
- **Compose:** `test/system/storage-sidecars.test.ts` — smtp emits Mailpit;
  ses/sendgrid emit none.
- **Fixtures + build gates:** add a `resource … kind: email` + a `mail.send`
  workflow to the corpus/e2e fixtures (`test/fixtures/corpus/resources.ddd` and
  its manifest; `test/e2e/fixtures/{python,java,elixir-vanilla}-build/*.ddd`) so
  `LOOM_TS_BUILD` / `python` / `java` / `phoenix` build gates compile the emitted
  client. Byte-identical fixtures stay untouched for models with no mailer.

## 7. Phasing
- **4.6-email-a** — grammar + IR unions + registry + verb table + hono adapter +
  Mailpit sidecar + lowering/validation/registry tests, delivered end to end on
  Hono (`LOOM_TS_BUILD` green). Self-contained vertical.
- **4.6-email-b** — the .NET / Java / Python / Phoenix adapters, each behind its
  own `build-generated-*` gate (the 4c pattern from workflow-resource-consumption).
- **4.6-email-c (later, own proposal)** — templated email: a `send(to,
  template, data)` verb over declared `template { subject, body }` entries
  (i18n-ready — the old §5.2 richer surface), HTML bodies, multi-recipient/cc/bcc.
  Introduce a `sendTemplated` capability + verb row; keep `send` as the plain-text
  primitive.

## 8. Open questions
1. **`kind:` literal** — *resolved* to `mailer` (§1): a corpus grep found the
   `where this.email == email` pattern in many files, a `NameRefIdent` collision
   that soft-keywording can't fix, so `email` as a surface keyword is out.
2. **smtp interface** — new `LoomInterface "smtp"` vs uniform `"sdk"` (v1 leans
   `sdk`; no functional difference for a single-verb kind).
3. **`from` override per-send** — v1 pins `from` on the storage config; a
   per-call `from` arg is a templated-email (4.6-c) concern.
4. **Verification hook** — email is the natural carrier for OIDC-adjacent
   verify-email flows (`quickstart` §4); wiring `send` into an auth verification
   step is out of scope here and sequenced after auth.
