// ---------------------------------------------------------------------------
// The validator diagnostic-message catalog (M-T1.11).
//
// Every `loom.*` diagnostic the AST validators (`src/language/validators/`) and
// the IR check leaves (`src/ir/validate/checks/`) raise has its human-readable
// text HERE, keyed by the stable `loom.*` code the call site already attaches.
// The call sites keep passing `code` + params; the wording lives in one place.
//
// Why one catalog: the codes were always stable, but the strings were inline
// literals across ~50 files, so there was no way to enumerate — let alone
// translate, review, or lint — the diagnostic surface.  This is the same move
// the user-visible UI strings made in M-T1.11 (`.loom/messages.en.json`), for
// the compiler's own output.
//
// KEY SHAPE.  The key is the `loom.*` code.  When one code legitimately carries
// several different messages (e.g. `loom.timer-cadence` reports six distinct
// cadence problems), each gets a `#<slug>` disambiguator — the code attached to
// the diagnostic is still the bare code, so nothing downstream changes.
// `codeOfMessageKey` recovers it.
//
// PARAMS are typed `unknown` deliberately: a message only ever interpolates its
// params into a string, so the catalog does not care whether a hole is a name,
// a count, or a flag, and no call site has to widen or cast to fit.
//
// LAYERING.  This module is a pure, import-free leaf under `src/diagnostics/`
// (alongside `contract.ts`) because its consumers span `language/`, `ir/` and
// `api/` — see CLAUDE.md, "a shared helper belongs at the layer its consumers
// live at".  Keep it free of imports so it stays browser-safe for the
// playground and cannot introduce a pipeline back-edge.
// ---------------------------------------------------------------------------

/** A catalog entry: a fixed string, or a builder over the values the message
 *  interpolates. */
type MessageEntry = string | ((params: never) => string);

export const DIAGNOSTIC_MESSAGES = {
  // ----------------------------------------------------------------------
  // src/language/validators/_shared.ts
  // ----------------------------------------------------------------------
  "loom.blank-message": "A 'message' clause must not be blank.",

  // ----------------------------------------------------------------------
  // src/language/validators/a11y.ts
  // ----------------------------------------------------------------------
  "loom.a11y-missing-alt": (p: { type: unknown }) =>
    `'${p.type}' renders an image but has no text alternative. Add 'alt: "…"' describing it, or 'decorative: true' if it conveys nothing (renders alt=""). Alt text is human content Loom can't derive — a missing alt fails WCAG 1.1.1.`,
  "loom.a11y-icon-only-no-name": `Icon-only 'Button' has no accessible name — a screen reader announces the meaningless default "Button". Add visible text ('Button { "Delete", icon: "trash" }') or an accessible name ('label: "Delete"', emitted as aria-label). A control without a name fails WCAG 4.1.2.`,
  "loom.a11y-theme-contrast": (p: {
    name: unknown;
    hex: unknown;
    ratio: unknown;
    aaNormal: unknown;
  }) =>
    `theme '${p.name}' colour '${p.hex}' has no readable text on it (best contrast ${p.ratio}:1, WCAG-AA needs ${p.aaNormal}:1). A control filled with it can't carry legible white or dark text — pick a colour a text colour clears AA on.`,

  // ----------------------------------------------------------------------
  // src/language/validators/auth.ts
  // ----------------------------------------------------------------------
  "loom.auth-without-user":
    "auth block requires a `user { … }` block to define the identity shape.",
  "loom.auth-unknown-provider": (p: { provider: unknown; knownProviders: unknown }) =>
    `unknown auth provider '${p.provider}'.  Known providers: ${p.knownProviders} (or omit \`provider:\` and supply a raw \`oidc { issuer }\`).`,
  "loom.auth-missing-issuer": (p: { selfHosted: unknown; provider: unknown }) =>
    p.selfHosted
      ? `provider '${p.provider}' is self-hosted and requires an \`oidc { issuer: … }\` block.`
      : 'oidc requires an `issuer` (env-bound).  Add an `oidc { issuer: env("OIDC_ISSUER") }` block.',
  "loom.auth-missing-client-id":
    'oidc requires a `clientId` (env-bound).  Add `clientId: env("OIDC_CLIENT_ID")` to the `oidc { … }` block.',
  "loom.auth-unknown-claim-field": (p: { field: unknown }) =>
    `claim mapping targets unknown user field '${p.field}'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/builder-call.ts
  // ----------------------------------------------------------------------
  "loom.bindable-input-value-arg": (p: { type: unknown }) =>
    `'${p.type}' binds to page state via 'bind:', not 'value:'. Did you mean 'bind: …'? With 'value:' the input renders uncontrolled and the state never wires up.`,
  "loom.file-upload-not-file-field": (p: { name: unknown; t: unknown }) =>
    `'FileUpload' must bind a 'File'-typed state field, but '${p.name}' is ${p.t}. ` +
    `Declare 'state { ${p.name}: File }' (a FileRef the upload writes back).`,
  "loom.legacy-vo-call": (p: { name: unknown }) =>
    `v2 syntax: construct '${p.name}' with builder-call form '${p.name} { ... }', not '${p.name}(...)'.`,
  "loom.legacy-part-call": (p: { name: unknown }) =>
    `v2 syntax: construct entity part '${p.name}' with builder-call form '${p.name} { ... }', not '${p.name}(...)'.`,
  "loom.unknown-construction-field": (p: {
    type: unknown;
    name: unknown;
    size: unknown;
    fields: unknown;
  }) => `'${p.type}' has no field '${p.name}'.` + (p.size ? ` Declared fields: ${p.fields}.` : ""),
  "loom.construction-missing-field": (p: { type: unknown; length: unknown; missing: unknown }) =>
    `'${p.type}' construction is missing required field${p.length}: ${p.missing}.`,
  "loom.create-server-field": (p: { name: unknown; name2: unknown; serverOwned: unknown }) =>
    `'${p.name}.create' can't set '${p.name2}' — it's a server-owned (${p.serverOwned}) field, ` +
    `populated automatically and absent from the factory input. Remove it.`,
  "loom.create-unknown-field": (p: {
    name: unknown;
    name2: unknown;
    size: unknown;
    createInput: unknown;
  }) =>
    `'${p.name}' has no create-input field '${p.name2}'.` +
    (p.size ? ` Create inputs: ${p.createInput}.` : ""),
  "loom.create-field-type": (p: {
    name: unknown;
    name2: unknown;
    expFam: unknown;
    expected: unknown;
    actual: unknown;
  }) =>
    `'${p.name}.create' field '${p.name2}' expects a ${p.expFam} value ('${p.expected}') but got '${p.actual}'.`,
  "loom.aggregate-not-a-builder": (p: { name: unknown }) =>
    `'${p.name}' is an aggregate — construct it with '${p.name}.create({ … })', not '${p.name} { … }'. ` +
    `The '{ }' builder literal is for value objects and entity parts.`,
  "loom.unknown-builder-type": (p: { name: unknown }) =>
    `Unknown builder type '${p.name}'. Expected a ValueObject, EntityPart, user-defined component, or stdlib walker primitive (e.g., Stack, CreateForm, Card).`,

  // ----------------------------------------------------------------------
  // src/language/validators/channel.ts
  // ----------------------------------------------------------------------
  "loom.channel-key-missing-field": (p: { name: unknown; key: unknown; evName: unknown }) =>
    `channel '${p.name}' key '${p.key}' is not a field of carried event '${p.evName}'.`,
  "loom.channelsource-unsupported-transport": (p: {
    name: unknown;
    chName: unknown;
    refName: unknown;
    storageType: unknown;
    ok: unknown;
    ok2: unknown;
  }) =>
    `channelSource '${p.name}' binds channel '${p.chName}' to storage '${p.refName}' of type '${p.storageType}', which is not a channel transport. Supported transports${p.ok}: ${p.ok2}.`,
  "loom.channelsource-incompatible": (p: {
    name: unknown;
    chName: unknown;
    delivery: unknown;
    retention: unknown;
    refName: unknown;
    storageType: unknown;
    ok: unknown;
  }) =>
    `channelSource '${p.name}' binds channel '${p.chName}' (${p.delivery}/${p.retention}) to storage '${p.refName}' of type '${p.storageType}', which can't realise it. Compatible: ${p.ok}.`,
  "loom.channelsource-not-yet-shipped": (p: {
    name: unknown;
    chName: unknown;
    delivery: unknown;
    retention: unknown;
    refName: unknown;
    storageType: unknown;
    length: unknown;
    length2: unknown;
  }) =>
    `channelSource '${p.name}' binds channel '${p.chName}' (${p.delivery}/${p.retention}) to storage '${p.refName}' of type '${p.storageType}'. That combination is compatible but not yet provisioned by a shipped ${p.storageType} driver.${p.length} or pick a combo ${p.storageType} does ship (${p.length2}).`,

  // ----------------------------------------------------------------------
  // src/language/validators/composition.ts
  // ----------------------------------------------------------------------
  "loom.top-level-domain-needs-single-system": (p: { kw: unknown; reason: unknown }) =>
    `A top-level '${p.kw}' composes into the project's single 'system', but ${p.reason}. ` +
    "Declare exactly one 'system { ... }' across the import graph (it may hold just the name, theme, user and deployment), or nest this declaration inside it.",
  "loom.duplicate-user-block": (p: { userCount: unknown }) =>
    `The project declares ${p.userCount} 'user { ... }' blocks, but a system admits at most one. ` +
    "Keep a single user block (it may live in any file that composes into the system).",
  "loom.duplicate-theme-block": (p: { themeCount: unknown }) =>
    `The project declares ${p.themeCount} 'theme { ... }' blocks, but a system admits at most one. ` +
    "Keep a single theme block (it may live in any file that composes into the system).",

  // ----------------------------------------------------------------------
  // src/language/validators/criterion.ts
  // ----------------------------------------------------------------------
  "loom.criterion-alias-collision": (p: { name: unknown; alias: unknown }) =>
    `criterion '${p.name}' binds the candidate alias '${p.alias}', but a parameter of the same name already exists — rename one so a bare '${p.alias}' is unambiguous.`,
  "loom.criterion-unsupported-target": (p: { name: unknown }) =>
    `criterion '${p.name}' has an unsupported candidate type. v1 supports 'of <Aggregate>' (a predicate over that aggregate) or 'of bool' (a pure ambient predicate); predicates over primitives / value objects / enums are reserved for the forthcoming 'from <Criterion>(args)' parameter-binding surface.`,
  "loom.criterion-impure#member-call": (p: { name: unknown; member: unknown }) =>
    `criterion '${p.name}' is impure: it calls the operation '${p.member}'. Criteria are pure predicates — call a 'function' (pure) instead of an 'operation' (mutating).`,
  "loom.criterion-impure#free-call": (p: { name: unknown; headName: unknown }) =>
    `criterion '${p.name}' is impure: it calls the operation '${p.headName}'. Criteria are pure predicates — call a 'function' (pure) instead of an 'operation' (mutating).`,
  "loom.criterion-cycle": (p: { name: unknown }) =>
    `criterion '${p.name}' is part of a reference cycle. A criterion may not (transitively) reference itself.`,
  "loom.criterion-arity": (p: {
    argc: unknown;
    name: unknown;
    want: unknown;
    want2: unknown;
    got: unknown;
    got2: unknown;
  }) =>
    p.argc
      ? `criterion '${p.name}' expects ${p.want} argument${p.want2}; reference it as '${p.name}(…)'.`
      : `criterion '${p.name}' expects ${p.want} argument${p.want2}, but ${p.got} ${p.got2} supplied.`,
  "loom.criterion-target-mismatch": (p: {
    name: unknown;
    critCandidateName: unknown;
    hostName: unknown;
  }) =>
    `criterion '${p.name}' is over '${p.critCandidateName}', but it is used here against '${p.hostName}'. A criterion can only filter the aggregate it is declared 'of'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/datasource.ts
  // ----------------------------------------------------------------------
  "loom.resource-api-target-kind": (p: { name: unknown; apiName: unknown; kind: unknown }) =>
    `resource '${p.name}' binds api '${p.apiName}', which is only valid on kind: api.  ` +
    `Got kind: ${p.kind}.  Bind a storage for kind '${p.kind}', or change the kind to 'api'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/deployable.ts
  // ----------------------------------------------------------------------
  "loom.ui-framework-unhostable": (p: {
    name: unknown;
    platform: unknown;
    uiName: unknown;
    uiFramework: unknown;
    menu: unknown;
  }) =>
    `Deployable '${p.name}' (platform '${p.platform}') cannot host ui '${p.uiName}' framework '${p.uiFramework}'. This platform hosts: ${p.menu}. A runtime-coupled framework (e.g. 'phoenixLiveView'/LiveView) can only run on its own runtime; a static-bundle framework (e.g. 'react') runs on any static-asset host.`,
  "loom.auth-ui-target-open": (p: { name: unknown; targetName: unknown }) =>
    `Frontend deployable '${p.name}' declares 'auth: ui' but its target '${p.targetName}' is not 'auth: required'; the guard has no session endpoint to probe.`,
  "loom.auth-ui-on-backend": (p: { name: unknown }) =>
    `Deployable '${p.name}' declares 'auth: ui', which is only valid on a frontend deployable; backends use 'auth: required'.`,
  "loom.platform-knob-out-of-menu": (p: {
    name: unknown;
    value: unknown;
    dName: unknown;
    reason: unknown;
    avail: unknown;
  }) => `'${p.name}: ${p.value}' on deployable '${p.dName}' ${p.reason}. ${p.avail}`,
  "loom.platform-knob-style-layout-mismatch": (p: {
    layout: unknown;
    name: unknown;
    style: unknown;
    supported: unknown;
  }) =>
    `'directoryLayout: ${p.layout}' on deployable '${p.name}' is not supported by the '${p.style}' emission style. Supported: ${p.supported}.`,

  // ----------------------------------------------------------------------
  // src/language/validators/duplicates.ts
  // ----------------------------------------------------------------------
  "loom.duplicate-handler": (p: { name: unknown; ctxName: unknown; kind: unknown }) =>
    `Duplicate handler '${p.name}' in context '${p.ctxName}'; a ${p.kind} shares its name ` +
    `with another handler or a workflow 'handle'. A 'route -> ${p.ctxName}.${p.name}' would ` +
    `be ambiguous — handler and workflow-handle names must be unique within a context.`,

  // ----------------------------------------------------------------------
  // src/language/validators/generics.ts
  // ----------------------------------------------------------------------
  "loom.self-outside-capability":
    "`Self id` is only valid inside a `capability` body (it resolves to the " +
    "implementing aggregate's type). Use a concrete `<Aggregate> id` here.",
  "loom.generic-position": (p: { ctors: unknown }) =>
    `A generic carrier ('${p.ctors}') is a transport shape — it may only appear as a ` +
    `repository find return type or a payload field, not in this position.`,
  "loom.generic-arg-not-carrier#nested-generic-carriers": (p: {
    ctors: unknown;
    ctors2: unknown;
  }) =>
    `Nested generic carriers are not supported yet — '${p.ctors}' applies ` +
    `'${p.ctors2}' to another generic instance. v1 allows a single ` +
    `carrier constructor (P3b adds nesting).`,
  "loom.generic-arg-not-carrier#requires-a-carrier-type": (p: { ctors: unknown }) =>
    `'${p.ctors}' requires a carrier type argument; 'slot' is a UI-only marker, ` +
    `not a boundary-crossing carrier.`,

  // ----------------------------------------------------------------------
  // src/language/validators/handlers.ts
  // ----------------------------------------------------------------------
  "loom.extern-handler-has-body": (p: { kind: unknown; name: unknown }) =>
    `extern ${p.kind} '${p.name}' must be bodyless — its implementation is a ` +
    `scaffold-once, user-owned file the generated dispatch calls, not a DSL body. ` +
    `End the declaration with ';', or drop 'extern' to make it a normal handler.`,
  "loom.handler-missing-body": (p: { kind: unknown; name: unknown }) =>
    `${p.kind} '${p.name}' requires a '{ … }' body. Mark it 'extern' (and end with ';') ` +
    `to hand the implementation to a scaffold-once user-owned file.`,

  // ----------------------------------------------------------------------
  // src/language/validators/i18n-strings.ts
  // ----------------------------------------------------------------------
  "loom.user-visible-concat": (p: { type: unknown }) =>
    `String concatenation in a user-visible '${p.type}' slot won't translate to languages with different word order, plural rules, or formatting. ` +
    'Use a backtick template interpolation — e.g. `Order {order.id}` rather than "Order " + order.id. See docs/old/proposals/i18n-strings.md.',

  // ----------------------------------------------------------------------
  // src/language/validators/inheritance.ts
  // ----------------------------------------------------------------------
  "loom.extends-self": (p: { name: unknown }) => `Aggregate '${p.name}' cannot extend itself.`,
  "loom.extends-non-abstract": (p: { name: unknown; baseName: unknown }) =>
    `Aggregate '${p.name}' extends '${p.baseName}', which is not abstract. ` +
    `Only an 'abstract aggregate' may be extended.`,
  "loom.inheritance-modifier-misplaced": (p: { inheritanceUsing: unknown; name: unknown }) =>
    `'inheritanceUsing(${p.inheritanceUsing})' is only valid on an 'abstract' base ` +
    `or an 'extends' subtype; '${p.name}' is neither.`,
  "loom.abstract-aggregate-behavior": (p: { name: unknown; kw: unknown }) =>
    `Abstract aggregate '${p.name}' cannot declare a '${p.kw}' action — abstract ` +
    `bases are never instantiated and have no polymorphic dispatch in v1. ` +
    `Declare it on each concrete subtype.`,
  "loom.es-tph-forced-own-table": (p: { name: unknown; why: unknown; baseName: unknown }) =>
    `'${p.name}' is ${p.why} but extends the sharedTable (TPH) base '${p.baseName}'. ` +
    `An event-sourced / document concrete cannot share the base table — declare ` +
    `'inheritanceUsing: ownTable' on '${p.name}' (D-ES-TPH).`,
  "loom.tph-own-override-unsupported": (p: { name: unknown; baseName: unknown }) =>
    `'${p.name}' declares inheritanceUsing: ownTable under the sharedTable (TPH) base ` +
    `'${p.baseName}' — a per-concrete storage override (mixed strategy) is not supported ` +
    `yet. The override concrete would live in its own table, outside the shared one, so ` +
    `'find all ${p.baseName}' and polymorphic '${p.baseName} id' references can't see it. ` +
    `Make '${p.name}' sharedTable to keep the whole hierarchy in one table, or make ` +
    `the entire hierarchy ownTable (TPC).`,
  "loom.extends-cycle": (p: { names: unknown; names2: unknown }) =>
    `Aggregate '${p.names}' is part of an 'extends' cycle: ` +
    `${p.names2}. Inheritance must form a chain, not a loop — ` +
    `break the cycle so one abstract base sits at the top.`,
  "loom.abstract-repository": (p: { name: unknown; targetName: unknown }) =>
    `'repository ${p.name} for ${p.targetName}': '${p.targetName}' is an abstract ` +
    `aggregate and has no repository of its own. Repositories belong to concrete subtypes.`,
  "loom.polymorphic-id-ref-unsupported": (p: { name: unknown }) =>
    `'${p.name} id' references the abstract base '${p.name}', which uses ` +
    `inheritanceUsing: ownTable (TPC) — there is no single table to key against, so the ` +
    `foreign-key target is ambiguous across the per-concrete tables. Reference a concrete ` +
    `subtype's id (e.g. 'Customer id'), or change '${p.name}' to ` +
    `inheritanceUsing: sharedTable (TPH) to allow polymorphic references.`,
  "loom.polymorphic-id-ref-mixed-strategy": (p: { name: unknown; names: unknown }) =>
    `'${p.name} id' references the abstract base '${p.name}', but its hierarchy mixes ` +
    `storage strategies: ${p.names} override(s) to inheritanceUsing: ownTable and live in a ` +
    `separate table, so a polymorphic '${p.name} id' would silently miss them. Reference ` +
    `a concrete subtype's id instead, or make every concrete sharedTable (TPH) so the ` +
    `whole hierarchy shares one table.`,

  // ----------------------------------------------------------------------
  // src/language/validators/match.ts
  // ----------------------------------------------------------------------
  "loom.match-subject-not-simple":
    `A variant 'match' subject must be a simple reference or let-bound name — not a call. ` +
    `Bind the result to a 'let' first, then match on that name (avoids double-evaluation).`,

  // ----------------------------------------------------------------------
  // src/language/validators/migration.ts
  // ----------------------------------------------------------------------
  "loom.migration-duplicate-name": (p: { name: unknown }) =>
    `Duplicate migration block name ${p.name}.`,
  "loom.rename-to-self#table": (p: { fromTable: unknown; to: unknown }) =>
    `Table rename '${p.fromTable} -> ${p.to}' names the same aggregate on both sides — a rename must change the name.`,
  "loom.rename-to-self#field": (p: { agg: unknown; field: unknown }) =>
    `Rename of '${p.agg}.${p.field}' names the same field on both sides — a rename must change the name.`,
  "loom.rename-duplicate-source#table-is-renamed-more-than": (p: { fromTable: unknown }) =>
    `Table '${p.fromTable}' is renamed more than once — an aggregate can be renamed FROM only once (ambiguous origin).`,
  "loom.rename-duplicate-source#field-is-renamed-more-than": (p: { sourceKey: unknown }) =>
    `Field '${p.sourceKey}' is renamed more than once — a column can be renamed FROM only once (ambiguous origin).`,
  "loom.rename-duplicate-target#two-renames-target-aggregate": (p: { to: unknown }) =>
    `Two renames target aggregate '${p.to}' — an aggregate can be renamed TO only once (ambiguous destination).`,
  "loom.rename-duplicate-target#two-renames-target-a-column": (p: { targetKey: unknown }) =>
    `Two renames target '${p.targetKey}' — a column can be renamed TO only once (ambiguous destination).`,
  "loom.migration-sql-empty": "Empty sql step — a raw migration statement must not be blank.",
  "loom.backfill-unknown-field": (p: { field: unknown; agg: unknown }) =>
    `'${p.field}' is not a field of aggregate '${p.agg}' — a backfill targets a live field (it names the newly-added column).`,
  "loom.backfill-duplicate": (p: { key: unknown }) =>
    `Field '${p.key}' is backfilled more than once in this block — one backfill per column per block (ambiguous value).`,

  // ----------------------------------------------------------------------
  // src/language/validators/names.ts
  // ----------------------------------------------------------------------
  "loom.unknown-name": (p: { hint: unknown; name: unknown }) =>
    p.hint
      ? `Unknown name '${p.name}' — did you mean '${p.hint}'?`
      : `Unknown name '${p.name}' — no parameter, local, field, enum value, or declaration with this name is in scope.`,

  // ----------------------------------------------------------------------
  // src/language/validators/payload.ts
  // ----------------------------------------------------------------------
  "loom.payload-name-conflict#duplicate-payload-in-context": (p: {
    name: unknown;
    ctxName: unknown;
  }) => `Duplicate payload '${p.name}' in context '${p.ctxName}'.`,
  "loom.payload-name-conflict#payload-collides-with-a": (p: {
    name: unknown;
    peerNames: unknown;
    ctxName: unknown;
  }) =>
    `Payload '${p.name}' collides with a ${p.peerNames} of the same name in ` +
    `context '${p.ctxName}'.`,
  "loom.payload-duplicate-field": (p: { name: unknown; mName: unknown }) =>
    `Duplicate field '${p.name}' in payload '${p.mName}'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/permissions.ts
  // ----------------------------------------------------------------------
  "loom.permission-implies-self": (p: { name: unknown }) =>
    `permission '${p.name}' cannot 'implies' itself.`,
  "loom.permission-implies-unknown": (p: { name: unknown; target: unknown; subName: unknown }) =>
    `permission '${p.name}' implies '${p.target}', which is not a permission declared ` +
    `in subdomain '${p.subName}'. Declare it in a 'permissions { … }' block, or fix the name.`,

  // ----------------------------------------------------------------------
  // src/language/validators/policy-fn.ts
  // ----------------------------------------------------------------------
  "loom.policy-fn-return-type": (p: { name: unknown }) =>
    `policy function '${p.name}' must return 'bool' — an authorization predicate is a boolean point gate.`,
  "loom.policy-fn-cycle": (p: { name: unknown }) =>
    `policy function '${p.name}' is part of a reference cycle. A policy function may not (transitively) reference itself.`,
  "loom.policy-fn-arity": (p: {
    argc: unknown;
    name: unknown;
    want: unknown;
    want2: unknown;
    got: unknown;
    got2: unknown;
  }) =>
    p.argc
      ? `policy function '${p.name}' expects ${p.want} argument${p.want2}; reference it as '${p.name}(…)'.`
      : `policy function '${p.name}' expects ${p.want} argument${p.want2}, but ${p.got} ${p.got2} supplied.`,

  // ----------------------------------------------------------------------
  // src/language/validators/repository.ts
  // ----------------------------------------------------------------------
  "loom.repository-find-deprecated": (p: { name: unknown }) =>
    `repository find '${p.name}' is a wire-shaped list query — pass a criterion to ` +
    `'run' (Repo.run(<Criterion>(args))) or name a 'retrieval' instead of accreting a ` +
    `bespoke list finder on the repository. (A unique-key reconstitution find returning a ` +
    `single 'T' / 'T?' stays fine.)`,

  // ----------------------------------------------------------------------
  // src/language/validators/seed.ts
  // ----------------------------------------------------------------------
  "loom.seed-foreign-aggregate": (p: { name: unknown; aggCtxName: unknown; ownCtxName: unknown }) =>
    `Seed row references aggregate '${p.name}' from context ` +
    `'${p.aggCtxName}', but the seed is declared in context ` +
    `'${p.ownCtxName}'. A seed may only populate aggregates of its ` +
    `own context.`,
  "loom.seed-duplicate-field": (p: { name: unknown; name2: unknown }) =>
    `Duplicate field '${p.name}' in seed row '${p.name2}'.`,
  "loom.seed-id-needs-raw":
    "An explicit `id` requires `seed raw { … }` — the domain create path mints ids. " +
    "Cross-references use explicit ids on the raw path (D-SEED-XREF).",
  "loom.seed-raw-unsupported-column": (p: { name: unknown }) =>
    `Raw seed column '${p.name}' is a value object / nested record — raw rows ` +
    "support scalar / enum / id columns only; use the domain path for value objects.",

  // ----------------------------------------------------------------------
  // src/language/validators/statements.ts
  // ----------------------------------------------------------------------
  "loom.this-id-in-create": (p: { name: unknown }) =>
    `Cannot read 'this.id' inside the create action on aggregate '${p.name}' — the id is not assigned until persistence, after the body runs.`,
  "loom.construction-field-type": (p: {
    name: unknown;
    type: unknown;
    expected: unknown;
    actual: unknown;
  }) => `Field '${p.name}' of '${p.type}' expects '${p.expected}' but got '${p.actual}'.`,
  "loom.component-prop-type": (p: {
    name: unknown;
    label: unknown;
    expected: unknown;
    actual: unknown;
  }) => `Prop '${p.name}' of ${p.label} expects '${p.expected}' but got '${p.actual}'.`,
  "loom.call-arg-type": (p: { i: unknown; label: unknown; expected: unknown; actual: unknown }) =>
    `Argument ${p.i} of ${p.label} expects '${p.expected}' but got '${p.actual}'.`,
  "loom.call-arg-count": (p: {
    label: unknown;
    length: unknown;
    length2: unknown;
    argsLength: unknown;
  }) => `${p.label} expects ${p.length} argument${p.length2}, got ${p.argsLength}.`,

  // ----------------------------------------------------------------------
  // src/language/validators/structural.ts
  // ----------------------------------------------------------------------
  "loom.slot-out-of-position": (p: { where: unknown }) =>
    `'slot' is only valid on a component's parameter list; found on ${p.where}.`,
  "loom.action-out-of-position": (p: { where: unknown }) =>
    `'action' is only valid on a component's parameter list; found on ${p.where}.`,
  "loom.action-nested-marker": (p: { argBase: unknown }) =>
    `'action(${p.argBase})' is not allowed — the callback argument must be a data type (primitive, aggregate, value object, …), not another UI marker.`,
  "loom.bare-aggregate-in-type": (p: { aggName: unknown }) =>
    `References across aggregate boundaries need an id link — write '${p.aggName} id' (or '${p.aggName} id[]' for many-to-many).`,
  "loom.cross-aggregate-entity-part": (p: { name: unknown; ownerName: unknown }) =>
    `Entity part '${p.name}' belongs to aggregate '${p.ownerName}'; cross-aggregate references must go through the root: use '${p.ownerName} id'.`,
  "loom.ambiguous-part-ref": (p: { name: unknown; list: unknown; names: unknown }) =>
    `Ambiguous entity-part reference '${p.name} id' — '${p.name}' is declared in ${p.list}. ` +
    `Entity parts are aggregate-local; reference the owning aggregate's root instead (e.g. '${p.names} id'), ` +
    `or rename one of the parts so the link is unambiguous.`,
  "loom.on-duplicate-subscription": (p: { name: unknown; o: unknown }) =>
    `Workflow '${p.name}' declares more than one on(...) reactor for event '${p.o}'. ` +
    `Each inbound event routes to one reactor; if these are intentional alternates, distinguish them by their 'by' clause.`,
  "loom.transactional-with-continuations": (p: { name: unknown }) =>
    `Workflow '${p.name}' is 'transactional' but declares a continuation handler. ` +
    `A reactor / handle runs in its own transaction — drop 'transactional', or remove the continuation.`,
  "loom.workflow-applier-on-non-event-sourced": (p: { name: unknown }) =>
    `Workflow '${p.name}' declares apply(...) but is not event-sourced. ` +
    `Add 'eventSourced' to the workflow header, or remove the applier.`,
  "loom.workflow-duplicate-applier": (p: { name: unknown; ap: unknown }) =>
    `Workflow '${p.name}' declares more than one applier for event '${p.ap}'. ` +
    `An event folds into state exactly one way — declare a single apply(${p.ap}).`,
  "loom.workflow-event-sourced-mutation": (p: { name: unknown }) =>
    `Workflow '${p.name}' is event-sourced — a handler body must not mutate 'this' directly. ` +
    `Replace the assignment with an 'emit' and fold it in an apply(...) block.`,
  "loom.workflow-emitted-event-no-applier": (p: { ev: unknown; name: unknown }) =>
    `Event '${p.ev}' is emitted in workflow '${p.name}' but no applier folds it. ` +
    `Add an apply(${p.ev}: ${p.ev}) block, or the event is recorded but never reflected in state.`,
  "loom.applier-on-non-event-sourced#ast": (p: { name: unknown }) =>
    `Aggregate '${p.name}' declares apply(...) but is not event-sourced. ` +
    `Appliers fold events into state; add 'persistedAs: eventLog' to the aggregate header, or remove the applier.`,
  "loom.event-sourced-multiple-creates#ast": (p: { name: unknown }) =>
    `Aggregate '${p.name}' is persistedAs: eventLog and declares multiple 'create' actions. ` +
    `An event-sourced aggregate has a single canonical creator (v1) — keep one 'create(...)'.`,
  "loom.duplicate-applier#ast": (p: { name: unknown; ap: unknown }) =>
    `Aggregate '${p.name}' declares more than one applier for event '${p.ap}'. ` +
    `An event folds into state exactly one way — declare a single apply(${p.ap}).`,
  "loom.event-sourced-command-mutation": (p: { name: unknown }) =>
    `Aggregate '${p.name}' is event-sourced — a command body must not mutate 'this' directly. ` +
    `Replace the assignment with an 'emit' and fold it in an apply(...) block.`,
  "loom.emitted-event-no-applier": (p: { ev: unknown; name: unknown }) =>
    `Event '${p.ev}' is emitted but no applier folds it. ` +
    `Add an apply(${p.ev}: ${p.ev}) block to aggregate '${p.name}', or the event is recorded but never reflected in state.`,
  "loom.applier-impure#apply-must-not-emit-an": (p: { ap: unknown }) =>
    `apply(${p.ap}) must not emit — an applier reacts to an event by folding it into state. ` +
    `Move the 'emit' to the command body that decides it.`,
  "loom.applier-impure#apply-must-not-call-out": (p: { ap: unknown }) =>
    `apply(${p.ap}) must not call out — applier bodies are deterministic, replayable folds (assignments and 'let' only).`,
  "loom.applier-impure#apply-must-not-guard-by": (p: { ap: unknown }) =>
    `apply(${p.ap}) must not guard — by the time an event is applied the decision is already made; put the guard in the command.`,
  "loom.token-nullable": (p: { name: unknown; aggName: unknown }) =>
    `Token field '${p.name}' on aggregate '${p.aggName}' cannot be nullable; \`token\` requires a non-optional type.`,
  "loom.provenanced-never-written": (p: { name: unknown; aggName: unknown }) =>
    `Provenanced field '${p.name}' on aggregate '${p.aggName}' is never written; no trace records will be produced.`,
  "loom.unique-on-event-sourced": (p: { how: unknown; name: unknown }) =>
    `\`unique (...)\` on ${p.how} aggregate '${p.name}' is not supported — uniqueness is enforced by a DB unique index, which needs a single relational table to constrain.`,
  "loom.unique-duplicate-column": (p: { name: unknown; col: unknown }) =>
    `\`unique\` on aggregate '${p.name}' lists column '${p.col}' twice.`,
  "loom.unique-unknown-field": (p: { name: unknown; col: unknown; known: unknown }) =>
    `\`unique\` on aggregate '${p.name}' references unknown field '${p.col}'. Known fields: ${p.known}.`,
  "loom.unique-collection-field": (p: { col: unknown; name: unknown }) =>
    `\`unique\` column '${p.col}' on aggregate '${p.name}' is a collection; a uniqueness key must list single-valued fields.`,
  "loom.entity-field-modifier": (p: {
    name: unknown;
    label: unknown;
    modifier: unknown;
    array: unknown;
  }) =>
    `Field '${p.name}' contains entity '${p.label}', so '${p.modifier}' does not apply — ` +
    `it is only valid on value properties. Drop it (write 'contains ${p.name}: ${p.label}${
      p.array
    }' if you want the keyword explicit).`,
  "loom.entity-field-optional-collection": (p: { name: unknown; label: unknown }) =>
    `Field '${p.name}' contains entity '${p.label}' as both a collection and optional — ` +
    `an empty collection already encodes absence; drop the '?'.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/structural-checks.ts
  // ----------------------------------------------------------------------
  "loom.applier-on-non-event-sourced#ir": (p: { name: unknown }) =>
    `aggregate '${p.name}' declares apply(...) but is not event-sourced. ` +
    `Appliers fold events into state; they only apply to a 'persistedAs: eventLog' aggregate. ` +
    `Add 'persistedAs: eventLog' to the aggregate header, or remove the applier.`,
  "loom.event-sourced-multiple-creates#ir": (p: { name: unknown; length: unknown }) =>
    `aggregate '${p.name}' is persistedAs: eventLog and declares ${p.length} 'create' actions. ` +
    `An event-sourced aggregate has a single canonical creator (v1) — keep one 'create(...)'.`,
  "loom.duplicate-applier#ir": (p: { name: unknown; count: unknown; eventName: unknown }) =>
    `aggregate '${p.name}' declares ${p.count} appliers for event '${p.eventName}'. ` +
    `An event folds into state exactly one way — declare a single apply(${p.eventName}).`,
  "loom.collection-op-in-ui#distinct":
    "collection op '.distinct' isn't available in a page body — only 'map' and 'join' render on the frontend; do the transformation in a view or derived property instead.",
  "loom.collection-op-in-ui#any-op": (p: { member: unknown }) =>
    `collection op '.${p.member}' isn't available in a page body — only 'map' and 'join' render on the frontend; do the transformation in a view or derived property instead.`,
  "loom.duplicate-valueobject": (p: { name: unknown }) =>
    `duplicate root-level value object '${p.name}' — declare it once in the workspace.`,
  "loom.duplicate-enum": (p: { name: unknown }) =>
    `duplicate root-level enum '${p.name}' — declare it once in the workspace.`,
  "loom.duplicate-system": (p: { name: unknown }) =>
    `duplicate system '${p.name}' — declare each system once across the workspace.`,
  "loom.duplicate-context": (p: { name: unknown }) =>
    `duplicate context '${p.name}' — context names must be unique across the workspace.`,
  "loom.valueobject-shadows-root": (p: { name: unknown; voName: unknown }) =>
    `context '${p.name}' declares value object '${p.voName}' that shadows the root-level declaration; rename one of them.`,
  "loom.enum-shadows-root": (p: { name: unknown; eName: unknown }) =>
    `context '${p.name}' declares enum '${p.eName}' that shadows the root-level declaration; rename one of them.`,
  "loom.duplicate-table": (p: { who: unknown; key: unknown }) =>
    `aggregates ${p.who} all map to the same database table \`${p.key}\` — ` +
    `their migrations would create and clobber one relation. Give the ` +
    `owning contexts distinct \`dataSource\` schemas (\`schema: "..."\`) so ` +
    `each lands in its own Postgres schema, or rename one aggregate.`,
  "loom.unique-valueobject-field": (p: { col: unknown; name: unknown }) =>
    `\`unique\` column '${p.col}' on aggregate '${p.name}' is a value object, which ` +
    `stores as several columns — a uniqueness key must list single-column ` +
    `(scalar / enum / id) fields.`,
  "loom.find-reserved-name": (p: { name: unknown; findName: unknown }) =>
    `repository '${p.name}' find '${p.findName}': name collides with the auto-emitted repository method '${p.findName}(...)'. ` +
    `Choose a different find name (e.g. 'persist', 'fetchById').`,
  "loom.duplicate-find": (p: { name: unknown; findName: unknown }) =>
    `repository '${p.name}' declares find '${p.findName}' more than once.`,
  "loom.generic-carrier-unsupported": (p: {
    where: unknown;
    ctor: unknown;
    unsupported: unknown;
    supportedPagedBackends: unknown;
  }) =>
    `${p.where} uses the generic carrier '${p.ctor}', but the backend(s) serving this context ` +
    `(${p.unsupported}) don't emit it yet (payload-transport-layer.md, P3b). ` +
    `It's supported on: ${p.supportedPagedBackends}.`,
  "loom.union-find-shape-unsupported": (p: {
    name: unknown;
    repoName: unknown;
    why: unknown;
    aggregateName: unknown;
  }) =>
    `find '${p.name}' on repository '${p.repoName}': ${p.why}. Supported v1 shape: ` +
    `\`find ${p.name}(...): ${p.aggregateName} or <Error>\` (absence → the error's ` +
    `HTTP status) or \`: ${p.aggregateName} option\` (absence → 404).`,
  "loom.union-unsupported": (p: {
    where: unknown;
    unsupported: unknown;
    supportedUnionBackends: unknown;
  }) =>
    `${p.where} uses a discriminated union (\`A or B\` / \`payload = A | B\` / \`T option\`), but ` +
    `the backend(s) serving this context (${p.unsupported}) don't emit it yet ` +
    `(payload-transport-layer.md, P4c–d). It's supported on: ${p.supportedUnionBackends}.`,
  "loom.when-unsupported": (p: {
    name: unknown;
    opName: unknown;
    unsupported: unknown;
    supportedWhenBackends: unknown;
  }) =>
    `operation '${p.name}.${p.opName}' declares a \`when\` gate, but the backend(s) ` +
    `serving this context (${p.unsupported}) don't emit the gate or the ` +
    `can-${p.opName} query yet. It's supported on: ${p.supportedWhenBackends}.`,
  "loom.operation-return-unsupported": (p: {
    name: unknown;
    opName: unknown;
    unsupported: unknown;
  }) =>
    `operation '${p.name}.${p.opName}' declares an \`or\`-union return type, but the ` +
    `backend(s) serving this context (${p.unsupported}) don't emit the ` +
    `producer-side route translation yet (exception-less.md). It's supported on: node, ` +
    `dotnet, python, java, elixir.`,
  "loom.unmapped-error-status": (p: { name: unknown; aggName: unknown; opName: unknown }) =>
    `error '${p.name}' returned by '${p.aggName}.${p.opName}' has no stdlib default HTTP ` +
    `status and no api \`httpStatus ${p.name} -> <code>\` mapping, so it defaults to 500. Add ` +
    `a \`httpStatus ${p.name} -> <code>\` line to the api serving this context to set an ` +
    `explicit status.`,
  "loom.reserved-structural-error-name": (p: { name: unknown }) =>
    `error '${p.name}' collides with a built-in structural-conflict name ` +
    `(M-T3.4a). That name is reserved: its HTTP status defaults to 409 and a ` +
    `\`httpStatus ${p.name} -> <code>\` line retargets the framework conflict, not ` +
    `just this payload. Rename the error to avoid the shadow.`,
  "loom.extern-on-private-operation": (p: { name: unknown; opName: unknown }) =>
    `aggregate '${p.name}' operation '${p.opName}': 'extern' isn't valid on a private operation. ` +
    `Private operations are callable only from inside the aggregate, so there's nowhere for an external handler to plug in. Make the operation public, or drop 'extern'.`,
  "loom.extern-body-not-precondition": (p: { name: unknown; opName: unknown; kind: unknown }) =>
    `aggregate '${p.name}' operation '${p.opName}': 'extern' bodies may only contain 'precondition' statements (found '${p.kind}'). ` +
    `The user-supplied handler owns mutation, emit, and any other logic — leave the .ddd body to the gates that run before it.`,
  "loom.event-sourced-direct-mutation": (p: { name: unknown; label: unknown }) =>
    `aggregate '${p.name}' ${p.label} mutates 'this' directly, but the aggregate is event-sourced. ` +
    `Command bodies on a 'persistedAs: eventLog' aggregate decide and 'emit'; the state change belongs in an apply(...) block. ` +
    `Replace the assignment with an 'emit', and fold it in an applier.`,
  "loom.emitted-event-unhandled": (p: { name: unknown; label: unknown; eventName: unknown }) =>
    `aggregate '${p.name}' ${p.label} emits '${p.eventName}' but no applier folds it. ` +
    `Every emitted event needs a matching apply(${p.eventName}: ${p.eventName}) on the aggregate, ` +
    `or the event is recorded but never reflected in state.`,
  "loom.applier-emits": (p: { name: unknown; event: unknown }) =>
    `aggregate '${p.name}' apply(${p.event}) emits an event. ` +
    `An applier reacts to an event by folding it into state — it must not emit. ` +
    `Move the 'emit' to the command body that decides it.`,
  "loom.applier-impure-call": (p: { name: unknown; event: unknown; stmtName: unknown }) =>
    `aggregate '${p.name}' apply(${p.event}) calls '${p.stmtName}'. ` +
    `Applier bodies must be deterministic, replayable folds — assignments and 'let' only, no side-effecting calls.`,
  "loom.applier-guard": (p: { name: unknown; event: unknown; kind: unknown }) =>
    `aggregate '${p.name}' apply(${p.event}) contains a '${p.kind}' statement. ` +
    `Guards belong in the command that decides the event; by the time it is applied the decision is already made.`,
  "loom.scaffold-unexpanded": (p: { name: unknown }) =>
    `un-expanded scaffold primitive '${p.name}' — walker-primitive-expander could not resolve its target aggregate/workflow/view; check that the referenced symbol exists in the surrounding context.`,
  "loom.distinct-non-scalar":
    "`.distinct` requires a scalar or value-object element — it can't dedupe a collection of entities or id references.",
  "loom.join-non-string": "`.join` requires a string collection.",
  "loom.reduction-non-comparable":
    "`.min`/`.max` require a comparable projection (number, money, string, or datetime).",
  "loom.match-non-union-subject": (p: { subjectType: unknown }) =>
    `variant 'match' subject is not a union — its type is ${
      p.subjectType
    }. A variant match discriminates an 'or'-union value by variant.`,
  "loom.match-unknown-variant": (p: { varType: unknown; variants: unknown }) =>
    `variant 'match' arm names '${p.varType}', which is not a variant of the subject union {${p.variants}}.`,
  "loom.match-duplicate-variant": (p: { varType: unknown }) =>
    `variant 'match' matches '${p.varType}' more than once — each variant may appear in at most one arm.`,
  "loom.match-non-exhaustive": (p: { missingTags: unknown }) =>
    `variant 'match' does not cover ${p.missingTags} and has no 'else' arm — the expression is undefined for those variants. Add the missing arm(s) or an 'else => …'.`,
  "loom.field-default-not-constant": (p: { owner: unknown; name: unknown; found: unknown }) =>
    `default for '${p.owner}.${p.name}' reads ${p.found}, but a field default is evaluated where no instance exists yet — ` +
    `notably the create-request wire schema, which every client sees. ` +
    `Write it as 'derived ${p.name}: … = …' if it is computed from other fields, or give the field an instance-independent default.`,
  "loom.currentuser-not-in-request-scope": (p: { location: unknown }) =>
    `currentUser is only available in per-request handlers (operations, workflows, repository find where filters). ` +
    `Found in ${p.location}; remove the reference or move the logic into a per-request body.`,
  "loom.unknown-permission": (p: { name: unknown }) =>
    `permissions.${p.name}: no permission named '${p.name}' is declared in this subdomain's 'permissions { ... }' block. ` +
    `Either add the declaration or fix the reference.`,

  // ----------------------------------------------------------------------
  // src/language/validators/template.ts
  // ----------------------------------------------------------------------
  "loom.interp-format-unsupported": (p: { format: unknown }) =>
    `Unsupported template format '${p.format}'. Supported ICU formats are ` +
    `\`number\` (incl. \`::currency/USD\`, \`::percent\`), \`date\`/\`time\`, ` +
    `\`plural\`/\`selectordinal\`, and \`select\`.`,
  "loom.interp-hole-type#select-format": (p: { t: unknown }) =>
    `A 'select' format expects a string or enum value, but this hole is '${p.t}'.`,
  "loom.interp-hole-type#date-format": (p: { kind: unknown; t: unknown }) =>
    `A '${p.kind}' format expects a 'datetime' value, but this hole is '${p.t}'.`,
  "loom.interp-hole-type#number-format": (p: { kind: unknown; t: unknown }) =>
    `A '${p.kind}' format expects a numeric value (int, decimal, or money), but this hole ` +
    `is '${p.t}'.`,
  "loom.interp-hole-type#not-stringifiable": (p: { t: unknown }) =>
    `Cannot interpolate a '${p.t}' — a template hole must be a string or a ` +
    `stringifiable value (number, bool, enum, an 'X id', or an aggregate with a ` +
    `'derived display'). Convert it first (e.g. wrap in a 'derived' that formats it).`,

  // ----------------------------------------------------------------------
  // src/language/validators/temporal.ts
  // ----------------------------------------------------------------------
  "loom.duration-arity": (p: { unit: unknown }) =>
    `'${p.unit}' takes exactly 1 argument — write '${p.unit}(<int>)'.`,
  "loom.duration-arg-type": (p: { unit: unknown; actual: unknown }) =>
    `'${p.unit}' takes an 'int' amount, got '${p.actual}'. ` +
    `Fractional spans are written in the finer unit ('hours(36)', not 'days(1.5)').`,

  // ----------------------------------------------------------------------
  // src/language/validators/tenancy.ts
  // ----------------------------------------------------------------------
  "loom.tenancy-duplicate": (p: { name: unknown }) =>
    `system '${p.name}' declares more than one 'tenancy by' line; keep just the first.`,
  "loom.orgpath-without-tenancy": (p: { member: unknown }) =>
    `'currentUser.${p.member}' requires a 'tenancy by user.<claim> of <Registry>' ` +
    `declaration — it is derived from the caller's tenant materialized path, resolved from ` +
    `the tenancy claim and registry.  Add the tenancy line, or drop the '${p.member}' reference.`,

  // ----------------------------------------------------------------------
  // src/language/validators/test-placement.ts
  // ----------------------------------------------------------------------
  "loom.test-redundant-for#a-nested-test-already-belongs": (p: { $refText: unknown }) =>
    `A nested 'test' already belongs to its enclosing subject — drop the ` +
    `'for ${p.$refText}' head (name a subject with 'for' only when ` +
    `the test is hoisted out of it).`,
  "loom.test-redundant-for#a-test-nested-in-context": (p: { name: unknown; $refText: unknown }) =>
    `A 'test' nested in context '${p.name}' already targets it — drop the ` +
    `'for ${p.$refText}' head.`,
  "loom.test-needs-target": (p: { name: unknown }) =>
    `A 'test' declared outside its subject must name it: ` +
    `\`test ${p.name} for <Subject> { … }\`.`,
  "loom.context-test-unsupported": (p: { name: unknown }) =>
    `Context integration tests emit on the node, python, dotnet, java, and elixir ` +
    `backends (test-placement.md Phase 3a/3b). Context '${p.name}' is not hosted ` +
    `by an integration-capable deployable, so this 'test' produces no runnable test yet.`,

  // ----------------------------------------------------------------------
  // src/language/validators/timer.ts
  // ----------------------------------------------------------------------
  "loom.timer-cadence#both-cron-and-every": (p: { name: unknown }) =>
    `timerSource '${p.name}' sets both 'cron:' and 'every:' — set exactly one.`,
  "loom.timer-cadence#neither-cron-nor-every": (p: { name: unknown }) =>
    `timerSource '${p.name}' sets neither 'cron:' nor 'every:' — a cadence is required.`,
  "loom.timer-cadence#cron-malformed": (p: { name: unknown; err: unknown }) =>
    `cron on timerSource '${p.name}' is invalid: ${p.err}.`,
  "loom.timer-cadence#every-malformed": (p: { name: unknown }) =>
    `'every:' on timerSource '${p.name}' is not a valid duration (e.g. 15s, 90m).`,
  "loom.timer-cadence#every-below-floor": (p: { name: unknown; minIntervalMs: unknown }) =>
    `'every:' on timerSource '${p.name}' is below the ${p.minIntervalMs}ms floor — timers may not fire more often than once per second.`,
  "loom.timer-cadence#every-cron-expressible": (p: { name: unknown; cronEquiv: unknown }) =>
    `'every:' on timerSource '${p.name}' is cleanly cron-expressible — write 'cron: "${p.cronEquiv}"'. 'every:' is only for intervals cron cannot express (sub-minute, or non-dividing like 7m/90m).`,

  // ----------------------------------------------------------------------
  // src/language/validators/toplevel-function.ts
  // ----------------------------------------------------------------------
  "loom.function-toplevel-block": (p: { name: unknown }) =>
    `A top-level 'function' must be expression-form ('function ${p.name}(…): T = <expr>'). ` +
    `Block-form top-level functions (a '{ … }' body) aren't supported yet — express it as a ` +
    `single expression, or make it a member of an aggregate / value object.`,
  "loom.function-recursive": (p: { name: unknown }) =>
    `Top-level 'function ${p.name}' is part of a recursion cycle. Expression-form functions ` +
    `inline at their call sites, so they must not call themselves — directly or through ` +
    `another top-level function that calls back.`,

  // ----------------------------------------------------------------------
  // src/language/validators/types.ts
  // ----------------------------------------------------------------------
  "loom.slot-member-access": (p: { member: unknown }) =>
    `'${p.member}' is not accessible on a slot value — slots are opaque JSX and have no addressable members.  Use a primitive- or aggregate-typed param if the body needs to read fields off this value.`,
  "loom.bare-collection-accessor": (p: { member: unknown }) =>
    `'${p.member}' over a collection needs a lambda — write '<collection>.${p.member}(x => …)'. A bare '.${p.member}' has no renderable form.`,
  "loom.unknown-member": (p: { member: unknown; record: unknown }) =>
    `'${p.member}' is not a member of '${p.record}'.`,
  "loom.collection-op-in-ui#avg":
    "collection op '.avg' isn't available in a page body — only 'map' and 'join' render on the frontend; do the transformation in a view or derived property instead.",
  "loom.avg-non-numeric": "`.avg` requires a numeric projection (int, long, decimal, or money).",
  "loom.intrinsic-bare": (p: { member: unknown; signature: unknown }) =>
    `'${p.member}' is an intrinsic operation and needs a call — write '.${p.member}${p.signature})'.`,
  "loom.intrinsic-arity": (p: { member: unknown; expected: unknown; signature: unknown }) =>
    `'${p.member}' takes ${p.expected} argument(s) — signature: ${p.member}${p.signature}.`,
  "loom.intrinsic-named-arg": (p: { member: unknown }) =>
    `'${p.member}' takes positional arguments only.`,
  "loom.intrinsic-arg-type": (p: {
    member: unknown;
    i: unknown;
    actual: unknown;
    signature: unknown;
    expected: unknown;
  }) =>
    `'${p.member}' argument ${p.i} is '${p.actual}' but the signature ${p.member}${p.signature} expects '${p.expected}'.`,
  "loom.intrinsic-unknown": (p: { name: unknown; member: unknown; known: unknown }) =>
    `'${p.name}' has no intrinsic '.${p.member}()'${p.known}.`,
  "loom.ternary-condition": (p: { condT: unknown }) =>
    `Ternary condition must be of type 'bool', got '${p.condT}'.`,
  "loom.ternary-branches": (p: { thenT: unknown; elseT: unknown }) =>
    `Ternary branches have incompatible types: then-branch is '${p.thenT}', ` +
    `else-branch is '${p.elseT}'.  One branch's type must be assignable to ` +
    `the other (both numeric, an optional and its inner, or a null literal against an optional).`,
  "loom.function-block-no-return": (p: { name: unknown; declared: unknown }) =>
    `Block-body function '${p.name}' must 'return' a value of type '${p.declared}'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/ui.ts
  // ----------------------------------------------------------------------
  "loom.extern-component-has-body": (p: { name: unknown; externPath: unknown }) =>
    `Extern component '${p.name}' must not declare a 'body:' — its rendering is owned by the hand-written module at '${p.externPath}'. Remove the body, or drop 'extern from' to make it a normal component.`,
  "loom.component-missing-body": (p: { name: unknown }) =>
    `Component '${p.name}' requires a 'body:' (or mark it 'extern from "<path>"' to hand rendering to a hand-written module).`,
  "loom.duplicate-action": (p: { name: unknown; surface: unknown }) =>
    `Duplicate action '${p.name}' on ${p.surface}; action names must be unique on a page/component.`,
  "loom.ui-channel-not-broadcast": (p: { name: unknown; chName: unknown; delivery: unknown }) =>
    `ui '${p.name}' subscribes to channel '${p.chName}', but its delivery is '${p.delivery}'.  Only 'delivery: broadcast' channels are UI-observable; 'queue' is work distribution.`,
  "loom.extern-function-shadows-stdlib": (p: { name: unknown }) =>
    `extern function '${p.name}' shadows a walker-stdlib primitive.  Pick a different name.`,
  "loom.store-lifetime-invalid": (p: {
    name: unknown;
    lifetime: unknown;
    storeLifetimes: unknown;
  }) =>
    `store '${p.name}': unknown lifetime '${p.lifetime}' — ` +
    `\`persist:\` accepts ${p.storeLifetimes}.`,
  "loom.ui-handler-refetch-target#refetch-in-needs-at-least": (p: { where: unknown }) =>
    `'refetch(…)' in ${p.where} needs at least one aggregate to refetch, e.g. 'refetch(Order)'.`,
  "loom.ui-handler-refetch-target#refetch-arguments-in-must": (p: { where: unknown }) =>
    `'refetch(…)' arguments in ${p.where} must each name an aggregate (e.g. 'refetch(Order)').`,
  "loom.ui-handler-refetch-target#unknown-refetch-target": (p: { name: unknown; where: unknown }) =>
    `Unknown refetch target '${p.name}' in ${p.where} — it must name an aggregate declared in this system.`,
  "loom.ui-handler-unsupported": (p: { where: unknown }) =>
    `Unsupported statement in ${p.where}.  A handler body supports 'toast(<message expression>)' (one argument) and 'refetch(<Aggregate>[, …])'.`,

  // ----------------------------------------------------------------------
  // src/language/validators/unions.ts
  // ----------------------------------------------------------------------
  "loom.union-position":
    `An inline 'or' union is a transport shape — it may only appear as a repository find ` +
    `return type, a payload field, or an operation return, not in this position. Name it ` +
    `with 'payload X = A | B' to use it elsewhere.`,
  "loom.union-variant-not-carrier": `'slot' is a UI-only marker, not a union variant — every variant must be a carrier type.`,
  "loom.union-duplicate-variant":
    `Duplicate union variant — each variant must be a distinct type so the wire ` +
    `discriminator stays unambiguous.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/api-checks.ts
  // ----------------------------------------------------------------------
  "loom.handler-param-reserved-id": (p: { name: unknown; kind: unknown; hName: unknown }) =>
    `context '${p.name}': ${p.kind} '${p.hName}' has a parameter named 'id', which is ` +
    `reserved — a bare 'id' in a handler body resolves to the current entity's implicit id, ` +
    `not the parameter. Rename it (e.g. 'orderId').`,
  "loom.query-handler-saves": (p: { name: unknown; qName: unknown }) =>
    `context '${p.name}': queryHandler '${p.qName}' mutates state (a save, op-call, emit, ` +
    `create, or assignment). A queryHandler must be read-only — use a commandHandler or a ` +
    `workflow for anything that writes.`,
  "loom.command-handler-multi-aggregate": (p: {
    name: unknown;
    cName: unknown;
    size: unknown;
    touched: unknown;
  }) =>
    `context '${p.name}': commandHandler '${p.cName}' touches ${p.size} aggregates ` +
    `(${p.touched}). A commandHandler orchestrates a single aggregate — ` +
    `a cross-aggregate orchestration must be a workflow.`,
  "loom.route-handler-unresolved#api-route-targets-context": (p: {
    name: unknown;
    label: unknown;
    context: unknown;
  }) =>
    `api '${p.name}': route '${p.label}' targets context '${p.context}', ` +
    `which is not a bounded context in this model.`,
  "loom.route-handler-unresolved#api-route-targets-but-context": (p: {
    name: unknown;
    label: unknown;
    context: unknown;
    handler: unknown;
  }) =>
    `api '${p.name}': route '${p.label}' targets '${p.context}.${p.handler}', ` +
    `but context '${p.context}' has no commandHandler, queryHandler, or workflow handle ` +
    `named '${p.handler}'.`,
  "loom.read-context-repo-write": (p: {
    name: unknown;
    label: unknown;
    method: unknown;
    targetKind: unknown;
    context: unknown;
    handler: unknown;
  }) =>
    `api '${p.name}': route '${p.label}' is a read (${p.method}) but targets ` +
    `${p.targetKind} '${p.context}.${p.handler}', which writes. A read ` +
    `position (an api read route, a queryHandler, or a 'reading' service) may not reach the ` +
    `mutating repository face — bind the read to a queryHandler.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/capability-checks.ts
  // ----------------------------------------------------------------------
  "loom.stamp-read-before-flush#aggregate-create-reads": (p: {
    name: unknown;
    cName: unknown;
    createStampFields: unknown;
  }) =>
    `aggregate '${p.name}' create '${p.cName}' reads an audit stamp field ` +
    `(${p.createStampFields}) that 'with auditable' only populates at persist time. ` +
    `The value is unset while the create body runs (it lands when the unit of work flushes). ` +
    `Remove the in-body read, or compute the value explicitly instead of relying on the audit stamp.`,
  "loom.stamp-read-before-flush#aggregate-operation-reads": (p: {
    name: unknown;
    opName: unknown;
    updateStampFields: unknown;
  }) =>
    `aggregate '${p.name}' operation '${p.opName}' reads an audit stamp field ` +
    `(${p.updateStampFields}) that 'with auditable' updates only at persist time. ` +
    `The new value is not applied until this operation's unit of work flushes, so the body would ` +
    `observe the prior value. Remove the in-body read, or compute the value explicitly.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/domain-service-checks.ts
  // ----------------------------------------------------------------------
  "loom.domain-service-no-emit": (p: { where: unknown; eventName: unknown }) =>
    `${p.where}: 'emit ${p.eventName}' is not allowed — a stateless domain service has no identity to attribute an event to.  Emit from the aggregate or workflow that owns the fact.`,
  "loom.domain-service-no-mutation": (p: { where: unknown; segments: unknown; kind: unknown }) =>
    `${p.where}: '${p.segments} ${p.kind}' writes to aggregate state, but a domain service has no 'this' to mutate.  To mutate a passed-in aggregate, call its own operation (e.g. 'src.withdraw(amount)') — the mutating tier; or return a value instead.`,
  "loom.domain-service-no-repo-write": (p: {
    where: unknown;
    recvName: unknown;
    member: unknown;
  }) =>
    `${p.where}: repository WRITE '${p.recvName}.${p.member}(…)' is not allowed — a domain service may run read-only queries (the 'reading' tier), but persistence writes (save/insert/update/delete/add/remove/commit) belong to the orchestrator (workflow / command handler).`,
  "loom.domain-service-no-workflow-start": (p: { where: unknown; recvName: unknown }) =>
    `${p.where}: starting workflow '${p.recvName}' is not allowed — a domain-layer service cannot reach into the application layer.`,
  "loom.domain-service-infra-call-from-aggregate": (p: {
    where: unknown;
    service: unknown;
    op: unknown;
  }) =>
    `${p.where}: call to domain service '${p.service}.${p.op}(…)' reaches beyond the aggregate boundary (a repository read, or mutating other passed-in aggregates), which the domain layer may not do from inside an aggregate operation.  Move the call into the orchestrating workflow / command handler, which loads the aggregates and owns the commit.`,
  "loom.domain-service-single-aggregate": (p: { name: unknown }) =>
    `domainService '${p.name}': every operation takes a single aggregate parameter — consider declaring the behaviour as an 'operation' on that aggregate instead of a domain service.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/index-suggestion-checks.ts
  // ----------------------------------------------------------------------
  "loom.index-suggestion": (p: { name: unknown; fName: unknown; where: unknown }) =>
    `'${p.name}.${p.fName}' is read on a query filter but has no index. ` + `Consider ${p.where}.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/migration-checks.ts
  // ----------------------------------------------------------------------
  "loom.backfill-target-unsupported#backfill-a-aggregate-stores": (p: {
    aggregate: unknown;
    field: unknown;
    persistedAs: unknown;
  }) =>
    `backfill '${p.aggregate}.${p.field}': a ${
      p.persistedAs
    } aggregate stores no scalar columns to backfill — use a raw sql step over its payload instead.`,
  "loom.backfill-target-unsupported#backfill-the-field-is-not": (p: {
    aggregate: unknown;
    field: unknown;
  }) =>
    `backfill '${p.aggregate}.${p.field}': the field is not a single scalar column (value-object, collection and entity fields cannot be backfilled — Phoenix stores a value object as one map column, so a leaf UPDATE would not be portable).`,
  "loom.migration-expr-unsupported": (p: { aggregate: unknown; field: unknown; reason: unknown }) =>
    `backfill '${p.aggregate}.${p.field}': ${p.reason}.`,
  "loom.backfill-type-mismatch": (p: {
    aggregate: unknown;
    field: unknown;
    got: unknown;
    expected: unknown;
  }) =>
    `backfill '${p.aggregate}.${p.field}': expression type '${p.got}' does not fit the field's type '${p.expected}'.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/projection-checks.ts
  // ----------------------------------------------------------------------
  "loom.projection-workflow-source-not-observable": (p: { name: unknown; wfName: unknown }) =>
    `projection '${p.name}': workflow '${p.wfName}' has no observable instance state ` +
    "(it needs a single id-shaped correlation/state field), so it can't be a projection source.",
  "loom.projection-workflow-source-eventsourced-unsupported": (p: {
    name: unknown;
    wfName: unknown;
  }) =>
    `projection '${p.name}': workflow '${p.wfName}' is event-sourced, whose instances are a ` +
    "per-request fold of its event stream (no state table). A projection over an event-sourced " +
    "workflow source is not emitted yet — source it from a state-backed (non-event-sourced) " +
    "workflow, or fold the events into a keyed 'projection' instead.",
  "loom.projection-workflow-source-join-unsupported": (p: { name: unknown }) =>
    `projection '${p.name}': a 'join' follow over a workflow source is not supported ` +
    "(by-id joins resolve an aggregate's identity, not a workflow instance). Read the " +
    "workflow's instance fields directly in 'select', or source the projection from an aggregate.",
  "loom.projection-workflow-source-ignoring-unsupported": (p: { name: unknown }) =>
    `projection '${p.name}': an 'ignoring' capability-filter bypass over a workflow source ` +
    "has no effect — a workflow instance read carries no capability query-filters. Remove the " +
    "'ignoring' clause.",
  "loom.projection-source-self": (p: { name: unknown }) =>
    `projection '${p.name}': a projection cannot source itself ('from ${p.name}').`,
  "loom.projection-source-not-materialized": (p: { name: unknown; srcName: unknown }) =>
    `projection '${p.name}': source projection '${p.srcName}' is query-time (a live read with ` +
    "no persisted read-model table), so there is nothing to read `from`. Source it from a folded " +
    "('on(e) { … }') projection, or from the underlying aggregate directly.",
  "loom.projection-source-join-unsupported": (p: { name: unknown }) =>
    `projection '${p.name}': a 'join' follow over a projection source is not supported ` +
    "(by-id joins resolve an aggregate's identity, not a read-model row). Read the source row's " +
    "fields directly in 'select', or source the projection from an aggregate.",
  "loom.projection-source-ignoring-unsupported": (p: { name: unknown }) =>
    `projection '${p.name}': an 'ignoring' capability-filter bypass over a projection source ` +
    "has no effect — a read-model row read carries no capability query-filters. Remove the " +
    "'ignoring' clause.",
  "loom.projection-query-and-fold-unsupported": (p: { name: unknown; source: unknown }) =>
    `projection '${p.name}' declares both a 'from ${p.source}' query source ` +
    `and 'on(e)' event folds. A query source and event folds together ` +
    `(seed-then-update) is a reserved combination — use EITHER a query-time ` +
    `projection ('from … select …') OR a folded one ('on(e) { … }'), not both.`,
  "loom.projection-shorthand-nonaggregate": (p: {
    name: unknown;
    source: unknown;
    sourceKind: unknown;
  }) =>
    `projection '${p.name}': the shorthand (select-less) form is supported for an ` +
    `AGGREGATE source only; source '${p.source}' is a ${p.sourceKind}. Add an explicit ` +
    `'select' (its rows are already served directly by the ${p.sourceKind}'s own read).`,
  "loom.projection-fields-without-select": (p: { name: unknown; source: unknown }) =>
    `projection '${p.name}' declares row fields but no 'select' to fill them, so every ` +
    `row would be empty. Add a 'select <field> = <expr>, …', or drop the fields for the ` +
    `shorthand form (the row then mirrors the '${p.source}' source's wire shape).`,
  "loom.projection-groupby-missing": (p: {
    name: unknown;
    aggregating: unknown;
    perRow: unknown;
    perRow2: unknown;
    perRow3: unknown;
  }) =>
    `projection '${p.name}' mixes aggregation ` +
    `(${p.aggregating}) with per-row select(s) ` +
    `(${p.perRow}). That is a GROUP BY — one row per distinct ` +
    `${p.perRow2} — so declare the grouping: add ` +
    `'group by ${p.perRow3}' before the ` +
    `'select'. Or aggregate ALL fields (a single-row total), or select all ` +
    `of them per-row.`,
  "loom.projection-aggregate-arg-not-columnar": (p: {
    name: unknown;
    field: unknown;
    op: unknown;
    source: unknown;
  }) =>
    `projection '${p.name}': 'select ${p.field} = ${p.op}(…)' aggregates a ` +
    `computed expression. An aggregation argument must be a plain column of the ` +
    `'${p.source}' source, written '<alias>.<field>' (e.g. '${p.op}(o.total)') — ` +
    `SQL aggregates a column, not a per-row computation.`,
  "loom.projection-select-unresolved": (p: {
    name: unknown;
    field: unknown;
    unresolved: unknown;
    source: unknown;
    hint: unknown;
  }) =>
    `projection '${p.name}': 'select ${p.field} = …' references '${p.unresolved}', which ` +
    `resolves to nothing — not a field of the '${p.source}' source, not a 'join' alias, ` +
    `not a parameter${p.hint}. It would be emitted as an undeclared identifier.`,
  "loom.projection-groupby-source-unsupported": (p: { name: unknown; why: unknown }) =>
    `projection '${p.name}' declares 'group by', but ${p.why}. A grouped ` +
    `projection reads (and groups) an AGGREGATE source's table in SQL — ` +
    `add 'from <Aggregate>'.`,
  "loom.projection-groupby-keyed-unsupported": (p: { name: unknown; correlationField: unknown }) =>
    `projection '${p.name}' declares both 'keyed by ${p.correlationField}' and ` +
    `'group by'. A grouped projection's rows ARE the groups (one per distinct ` +
    `key combination), not id-keyed entities — drop the 'keyed by'.`,
  "loom.projection-groupby-join-unsupported": (p: { name: unknown }) =>
    `projection '${p.name}': 'join' and 'group by' don't compose — a join is a ` +
    `by-id bulk load AFTER the query, so its columns can't participate in the SQL ` +
    `GROUP BY. Group by source columns only, or drop the 'group by'.`,
  "loom.projection-groupby-no-aggregate": (p: { name: unknown }) =>
    `projection '${p.name}' declares 'group by' but no aggregate 'select' ` +
    `(count/sum/avg/min/max) to compute per group — that is just DISTINCT. Add an ` +
    `aggregate select (e.g. 'orders = count()'), or drop the 'group by' for the ` +
    `per-row read.`,
  "loom.projection-groupby-key-not-columnar": (p: { name: unknown; source: unknown }) =>
    `projection '${p.name}': a 'group by' column must be a plain field of the ` +
    `'${p.source}' source (e.g. '<alias>.<field>'), optionally bucketed by a ` +
    `supported grouping transform ('<alias>.<datetime field>.startOfDay()'), so it ` +
    `can be grouped in SQL — other computed grouping keys are not supported yet.`,
  "loom.projection-groupby-select-not-grouped": (p: { name: unknown; field: unknown }) =>
    `projection '${p.name}': 'select ${p.field} = …' is per-row but not one of the ` +
    `'group by' columns, so it has no single value per group. Select a grouping ` +
    `column directly, aggregate it (sum/min/max/…), or add it to the 'group by'.`,
  "loom.projection-key-unknown": (p: { name: unknown; correlationField: unknown }) =>
    `projection '${p.name}' is keyed by '${p.correlationField}', ` +
    `which is not a declared state field.  Declare it as an id-shaped field, ` +
    `e.g. '${p.correlationField}: <Aggregate> id'.`,
  "loom.projection-key-not-id": (p: { name: unknown; correlationField: unknown }) =>
    `projection '${p.name}' is keyed by '${p.correlationField}', ` +
    `which is not id-shaped.  A projection's routing key must be an 'id' field ` +
    `(the row's primary key), e.g. '${p.correlationField}: <Aggregate> id'.`,
  "loom.projection-duplicate-on": (p: { name: unknown; param: unknown; event: unknown }) =>
    `projection '${p.name}' declares more than one 'on(${p.param}: ${p.event})' handler. ` +
    `Fold each event type in a single handler.`,
  "loom.projection-event-unkeyed": (p: {
    name: unknown;
    event: unknown;
    correlationField: unknown;
    param: unknown;
  }) =>
    `projection '${p.name}' folds '${p.event}', but that event has no ` +
    `'${p.correlationField}' field to route by.  Add the field to the event, ` +
    `or supply an explicit 'by <expr>' that extracts the key from '${p.param}'.`,
  "loom.projection-fold-impure": (p: {
    name: unknown;
    param: unknown;
    event: unknown;
    impurity: unknown;
  }) =>
    `projection '${p.name}' fold 'on(${p.param}: ${p.event})' ${p.impurity}. ` +
    `A projection fold must be a pure, replayable function of the event — ` +
    `assignments and 'let' only.  To read a repository or emit, use a reactor ` +
    `('on(e: Event)' in a workflow) instead.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/query-checks.ts
  // ----------------------------------------------------------------------
  "loom.find-where-not-queryable": (p: { name: unknown; findName: unknown; offending: unknown }) =>
    `repository '${p.name}' find '${p.findName}': ` +
    `where-clause is not queryable (${p.offending}). ` +
    `Allowed: comparisons, &&/||/!, parens, ` +
    `'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
  "loom.find-where-unknown-field": (p: {
    name: unknown;
    findName: unknown;
    unknown: unknown;
    aggName: unknown;
  }) =>
    `repository '${p.name}' find '${p.findName}': ` +
    `where-clause references unknown field ${p.unknown} on aggregate '${p.aggName}'.`,
  "loom.find-where-column-column": (p: { name: unknown; findName: unknown; bothCols: unknown }) =>
    `repository '${p.name}' find '${p.findName}': ` +
    `comparison between two columns (${p.bothCols}) is not queryable. ` +
    `Drizzle's eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
  "loom.criterion-not-selectable#not-selectable": (p: { name: unknown; offending: unknown }) =>
    `aggregate '${p.name}': a 'filter' capability predicate is not selectable (${p.offending}). ` +
    `Capability filters install at the query layer, so they must lower to the queryable subset: ` +
    `comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, 'currentUser.<field>', literals.`,
  "loom.criterion-not-selectable#unknown-field": (p: { name: unknown; unknown: unknown }) =>
    `aggregate '${p.name}': a 'filter' capability predicate references unknown field ${p.unknown} on '${p.name}'.`,
  "loom.seed-raw-non-literal-column": (p: { aggregate: unknown; name: unknown; value: unknown }) =>
    `seed raw '${p.aggregate}.${p.name}': a raw-seed column must be a scalar / enum / id ` +
    `literal (or 'now()'); the value '${p.value}' is computed at ` +
    `generate time, which the direct-INSERT seed path can't render. ` +
    `Use a literal value, or the domain seed path ('seed { … }' without 'raw').`,
  "loom.retrieval-where-not-queryable": (p: { name: unknown; offending: unknown }) =>
    `retrieval '${p.name}': where-clause is not queryable (${p.offending}). ` +
    `Allowed: comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
  "loom.retrieval-where-unknown-field": (p: {
    name: unknown;
    unknown: unknown;
    aggName: unknown;
  }) =>
    `retrieval '${p.name}': where-clause references unknown field ${p.unknown} on aggregate '${p.aggName}'.`,
  "loom.retrieval-where-column-column": (p: { name: unknown; bothCols: unknown }) =>
    `retrieval '${p.name}': comparison between two columns (${p.bothCols}) is not queryable. ` +
    `eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
  "loom.retrieval-sort-unknown-field": (p: {
    name: unknown;
    headName: unknown;
    aggName: unknown;
  }) =>
    `retrieval '${p.name}': sort references unknown field '${p.headName}' on aggregate '${p.aggName}'.`,
  "loom.retrieval-loads-unsupported": (p: { name: unknown }) =>
    `retrieval '${p.name}': explicit 'loads:' is not supported yet — ` +
    `retrievals load the whole aggregate. (Per-operation autoload is planned.)`,
  "loom.find-gate-not-current-user": (p: {
    name: unknown;
    findName: unknown;
    offending: unknown;
  }) =>
    `find '${p.name}.${p.findName}': a \`requires\` gate runs before the query (no row ` +
    `exists yet), so it may only reference \`currentUser\` (and constants) — \`${p.offending}\` ` +
    "is not available here. Use `where` to scope which rows return; use `requires` to " +
    "allow / deny the caller.",
  "loom.projection-gate-without-source": (p: { name: unknown }) =>
    `projection '${p.name}': a \`requires\` gate guards a query-time read, but this ` +
    "projection declares no `from` source. Add a `from <Aggregate>` clause, or drop the gate.",
  "loom.projection-gate-not-current-user": (p: { name: unknown; offending: unknown }) =>
    `projection '${p.name}': a \`requires\` gate runs before the query (no row exists ` +
    `yet), so it may only reference \`currentUser\` (and constants) — \`${p.offending}\` is not ` +
    "available here. Use `where` to scope which rows return; use `requires` to allow / deny " +
    "the caller.",

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/store-checks.ts
  // ----------------------------------------------------------------------
  "loom.store-url-field-unsupported": (p: { where: unknown; name: unknown; k: unknown }) =>
    `${p.where}: field '${p.name}' (${p.k}) cannot be URL-synced — ` +
    `\`persist: url\` fields must be scalar (string/number/bool/enum/id). ` +
    `Use \`persist: local\` for structural state.`,
  "loom.store-action-view-effect": (p: { where: unknown; name: unknown; sName: unknown }) =>
    `${p.where} action '${p.name}': \`${p.sName}(…)\` is a view-scoped effect — ` +
    `a store has no router/socket to ${p.sName} on.  Move it to the calling page's ` +
    `action (the page owns navigation; the store action only mutates state).`,
  "loom.store-action-cycle": (p: { node: unknown; path: unknown }) =>
    `store action '${p.node}' is part of a call cycle (${p.path}) — ` +
    `store actions must compose acyclically so each store's update reduction terminates.`,
  "loom.store-state-inline-write": (p: {
    surfaceWhere: unknown;
    name: unknown;
    storeSeg: unknown;
    fieldSeg: unknown;
  }) =>
    `${p.surfaceWhere} action '${p.name}': cannot write store state inline ` +
    `(\`${p.storeSeg}.${p.fieldSeg} := …\`).  Store state changes only inside a store ` +
    `action — add an \`action\` to \`store ${p.storeSeg}\` and call it (\`${p.storeSeg}.<action>()\`).`,
  "loom.store-lifetime-liveview-unsupported": (p: { where: unknown; lifetime: unknown }) =>
    `${p.where}: \`persist: ${p.lifetime}\` is not supported on the ` +
    `phoenixLiveView frontend — a LiveView store is a server-side per-process struct ` +
    `with no browser storage, and URL state is owned by the page's \`handle_params\`. ` +
    `Use \`persist: memory\` here; the persistence tiers ship on the SPA frontends.`,
  "loom.store-cross-store-on-liveview-unsupported": (p: {
    where: unknown;
    store: unknown;
    name: unknown;
    storeName: unknown;
    actionName: unknown;
  }) =>
    `${p.where}: calls \`${p.store}.${p.name}(…)\`, a DIFFERENT store's action, ` +
    `on the phoenixLiveView frontend.  A LiveView store action is a pure struct ` +
    `transform over its OWN store's per-page assign and can't reach store ` +
    `'${p.store}'.  Move the cross-store coordination to the calling page's action ` +
    `(call \`${p.storeName}.${p.actionName}()\` then \`${p.store}.${p.name}()\` from the page).`,
  "loom.feliz-async-effect-unsupported": (p: {
    where: unknown;
    uiName: unknown;
    name: unknown;
    reason: unknown;
  }) =>
    `${p.where}: \`match await …\` (an async effect) is used on ui '${p.uiName}', hosted by ` +
    `the Feliz (F#/Fable) deployable '${p.name}', but this shape is not rendered on the ` +
    `Feliz frontend yet — ${p.reason}.  Supported in a PAGE action: \`match await ` +
    `<api>.<Agg>.<op>(args?) { <Variant> b => … … else? => … }\` — an aggregate instance op ` +
    `(with or without params), one or more named success/error arms, and an optional ` +
    `\`else\`.  Otherwise host this ui on an SPA frontend (React/Vue/Svelte/Angular), or ` +
    `drive the op through a form primitive (CreateForm/OperationForm).  Tracked in M-T6.15.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/system-checks.ts
  // ----------------------------------------------------------------------
  "loom.projection-whole-table-aggregation-unsupported": (p: {
    name: unknown;
    field: unknown;
    op: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `projection '${p.name}': 'select ${p.field} = ${p.op}(…)' is a whole-table aggregation, which deployable '${p.dName}' (platform '${p.platform}') can't generate yet — only the node (Hono) backend has ported it. Host the projection on a supported deployable, or express the read per-row.`,
  "loom.projection-groupby-unsupported-backend": (p: {
    name: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `projection '${p.name}' uses 'group by' (the grouped read model), which deployable '${p.dName}' (platform '${p.platform}') can't generate yet. Host the projection on a supported deployable, or express the read per-row.`,
  "loom.paged-query-handler-unsupported-backend": (p: {
    name: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `queryHandler '${p.name}' returns a \`paged\` envelope, which is currently only emitted on the node (Hono) backend; deployable '${p.dName}' (platform '${p.platform}') can't generate it yet.`,
  "loom.projection-query-time-unsupported": (p: {
    name: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `projection '${p.name}' uses the query-time comprehension ('from'/'where'/'join'/'select'), which deployable '${p.dName}' (platform '${p.platform}') can't generate yet. Express the read as a folded 'projection', or host it on a supported deployable.`,
  "loom.projection-workflow-source-unsupported-backend": (p: {
    name: unknown;
    source: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `projection '${p.name}' is sourced 'from ${p.source}' (a workflow's instance rows), which deployable '${p.dName}' (platform '${p.platform}') can't generate yet. Host it on a supported backend, or source the projection from an aggregate.`,
  "loom.projection-source-unsupported-backend": (p: {
    name: unknown;
    source: unknown;
    dName: unknown;
    platform: unknown;
  }) =>
    `projection '${p.name}' is sourced 'from ${p.source}' (another projection's read-model rows), which deployable '${p.dName}' (platform '${p.platform}') can't generate yet. Host it on a supported backend, or source the projection from an aggregate.`,
  "loom.datagrid-unsupported-target": (p: { name: unknown; dName: unknown; fw: unknown }) =>
    `page '${p.name}' uses 'DataGrid', which deployable '${p.dName}' can't render ` +
    `(frontend '${p.fw}'). DataGrid is a TanStack row model, so it ships wherever ` +
    `TanStack can run: react, vue, svelte, angular and feliz. It is a permanent gap on flutter ` +
    `(the native target has no JS runtime) and on heex (a client row model has no LiveView ` +
    `analogue). Use 'Table' — it supports column sort and pagination on every frontend, ` +
    `server-driven on Phoenix and Flutter — or host this page on one of the five above.`,
  "loom.chart-unsupported-target": (p: { what: unknown; name: unknown; uiFramework: unknown }) =>
    `${p.what} uses 'Chart', which deployable '${p.name}' can't render ` +
    `(frontend '${p.uiFramework}'). Chart ships on react — on every ` +
    `react design pack. Host this ui on a react deployable, or bind the grouped ` +
    `projection to 'Table' — it renders the same rows on every frontend.`,
  "loom.ui-projection-read-unsupported#frontend-has-no-client": (p: {
    what: unknown;
    name: unknown;
    dName: unknown;
    fw: unknown;
  }) =>
    `${p.what} reads projection '${p.name}', which deployable '${p.dName}' can't render ` +
    `(frontend '${p.fw}' generates no projection client). Projection reads ` +
    `ship on react today; host this ui there, or read the source aggregate directly.`,
  "loom.auth-ui-unsupported-framework": (p: { name: unknown; uiFramework: unknown }) =>
    `Deployable '${p.name}': 'auth: ui' is currently only supported on react, vue, svelte, and angular frontends; framework '${p.uiFramework}' isn't supported yet.`,
  "loom.ui-realtime-unsupported#backend-serves-no-sse": (p: {
    name: unknown;
    uiName: unknown;
    target: unknown;
  }) =>
    `Deployable '${p.name}': ui '${p.uiName}' declares 'on <channel>.<Event>' live-event handler(s), but its ${
      p.target
    } does not serve the realtime SSE wire, so the handlers are silently dropped. Target a realtime-serving backend (node, dotnet, java, python) or remove the handlers.`,
  "loom.ui-realtime-unsupported#frontend-has-no-consumer": (p: {
    name: unknown;
    uiName: unknown;
    framework: unknown;
  }) =>
    `Deployable '${p.name}': ui '${p.uiName}' declares 'on <channel>.<Event>' live-event handler(s), but its frontend framework '${p.framework}' has no realtime consumption, so the handlers are silently dropped.`,
  "loom.flutter-primitive-unsupported": (p: { where: unknown; name: unknown; dName: unknown }) =>
    `${p.where}: uses the '${p.name}' primitive, but the Flutter frontend has no renderer ` +
    `for it yet (FileUpload is the one deferred primitive — a standalone multipart upload ` +
    `needs the File-type-on-Flutter foundation) — so hosting deployable '${p.dName}' ` +
    `(platform 'flutter') would emit a \`// flutter pack: no renderer\` comment where the ` +
    `widget should be and the element would silently vanish.  Host this page on an SPA ` +
    `frontend (react / vue / svelte / angular) or a Feliz/Phoenix deployable, or use the ` +
    `supported primitives (display / layout, the Field/MultilineField/PasswordField/` +
    `NumberField/Toggle/SelectField inputs, Tabs, forms, and Modal) until '${p.name}' ` +
    `gains a Flutter renderer.`,
  "loom.default-deny-ungated#denybydefault-is-reachable": (p: { name: unknown; opName: unknown }) =>
    `denyByDefault: '${p.name}.${p.opName}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
  "loom.default-deny-ungated#denybydefault-workflow": (p: { label: unknown }) =>
    `denyByDefault: workflow '${p.label}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
  "loom.default-deny-ungated#denybydefault-find-is-reachable": (p: {
    name: unknown;
    findName: unknown;
  }) =>
    `denyByDefault: find '${p.name}.${p.findName}' is reachable on an 'auth: required' deployable but declares no \`requires\` gate. Add a \`requires <expr>\` (use \`requires true\` to allow anonymous access).`,
  "loom.audit-history-ungated": (p: {
    aggregateName: unknown;
    aggregateName2: unknown;
    name: unknown;
  }) =>
    `denyByDefault: '${p.aggregateName}' is \`audited\`, so it serves \`GET /${p.aggregateName2}/{id}/history\`, but its list read declares no \`requires\` gate — the change history is reachable by any authenticated caller. Declare \`find all(): ${p.aggregateName}[] requires <expr>\` on '${p.name}'; history inherits that gate (use \`requires true\` to allow anonymous access).`,
  "loom.ui-id-ref-unknown-aggregate": (p: {
    deployableName: unknown;
    source: unknown;
    target: unknown;
  }) =>
    `UI-mounting deployable '${p.deployableName}': '${p.source}' references ${p.target} id, but no aggregate '${p.target}' is declared in the system.`,
  "loom.ui-id-ref-unmounted": (p: { deployableName: unknown; source: unknown; target: unknown }) =>
    `UI-mounting deployable '${p.deployableName}': '${p.source}' references ${p.target} id, but '${p.target}' is not mounted on this deployable's modules.  ` +
    `Mount the module containing '${p.target}' on the deployable's targeted backend, or remove the reference.`,
  "loom.ui-id-ref-no-display": (p: { deployableName: unknown; source: unknown; target: unknown }) =>
    `UI-mounting deployable '${p.deployableName}': '${p.source}' references ${p.target} id, but '${p.target}' has no 'derived display' clause.  ` +
    `Add 'derived display: string = <field>' to '${p.target}' so the form's <Select> picker can label options.`,
  "loom.duplicate-host-port": (p: { port: unknown; owners: unknown }) =>
    `Host port ${p.port} is published by more than one service (${p.owners}); ` +
    `\`docker compose up\` would abort with a port-in-use error. Give each deployable a ` +
    `distinct \`port:\`.`,
  "loom.duplicate-service-slug": (p: { names: unknown; slug: unknown }) =>
    `Deployables ${p.names} all resolve to the same ` +
    `docker-compose service slug '${p.slug}', so they would silently merge into one output ` +
    `directory and one compose service. Rename them to distinct slugs (names must differ by ` +
    `more than case / punctuation).`,
  "loom.channelsource-unbound": (p: { name: unknown; channelName: unknown }) =>
    `channelSource '${p.name}' (channel '${p.channelName}') is listed by no ` +
    `deployable's 'channels:' clause — the binding is declared but inert: no broker ` +
    `is provisioned and events stay on in-process dispatch. Add it to a deployable ` +
    `that produces or consumes '${p.channelName}', or remove it.`,
  "loom.deployable-channel-unrelated": (p: {
    name: unknown;
    csName: unknown;
    channelName: unknown;
    ctxName: unknown;
    carries: unknown;
  }) =>
    `Deployable '${p.name}' lists channelSource '${p.csName}', but it neither ` +
    `hosts channel '${p.channelName}'\`s owning context ('${p.ctxName}') nor ` +
    `consumes any event it carries (${p.carries}). ` +
    `This wiring routes nothing — remove it, or host a producing/consuming context.`,
  "loom.channel-consumer-unwired": (p: {
    name: unknown;
    chName: unknown;
    carries: unknown;
    csNames: unknown;
  }) =>
    `Deployable '${p.name}' consumes events of channel '${p.chName}' ` +
    `(${p.carries}), which is bound to a ` +
    `broker via channelSource '${p.csNames}' on another deployable — but '${p.name}' ` +
    `doesn't list the binding. Once traffic rides the broker this consumer would ` +
    `silently receive nothing. Add \`channels: [${p.csNames}]\` to '${p.name}'.`,
  "loom.relay-target-not-subscribed": (p: {
    name: unknown;
    uiName: unknown;
    channelName: unknown;
    owner: unknown;
    pName: unknown;
    relayName: unknown;
  }) =>
    `Deployable '${p.name}': ui '${p.uiName}' subscribes to channel ` +
    `'${p.channelName}' (context '${p.owner}') via an 'on ${p.pName}.<Event>' handler, ` +
    `but its relay backend '${p.relayName}' neither hosts '${p.owner}' nor binds the ` +
    `channel — the SSE relay can't legally serve those events, so the handler receives ` +
    `nothing. Host '${p.owner}' on '${p.relayName}', or add a channelSource for ` +
    `'${p.channelName}' to its 'channels:' clause.`,
  "loom.persistence-mode-unsupported": (p: {
    name: unknown;
    ctxName: unknown;
    aggName: unknown;
    persistedAs: unknown;
    kind: unknown;
    ctxName2: unknown;
    kind2: unknown;
  }) =>
    `Deployable '${p.name}' hosts aggregate '${p.ctxName}.${p.aggName}' ` +
    `(persistedAs: ${p.persistedAs}, ` +
    `needs dataSource kind: ${p.kind}) but lists no matching dataSource. ` +
    `Declare ` +
    `\`dataSource ${p.ctxName2}${p.kind2} ` +
    `{ for: ${p.ctxName}, kind: ${p.kind}, use: <storage> }\` ` +
    `and add it to '${p.name}'\`s 'dataSources:' list.`,
  "loom.datasource-unused": (p: {
    name: unknown;
    dsName: unknown;
    kind: unknown;
    contextName: unknown;
    reason: unknown;
  }) =>
    `Deployable '${p.name}' lists resource '${p.dsName}' (kind: ${p.kind}) for ` +
    `context '${p.contextName}', but ${p.reason}.  This binding routes no data — ` +
    `remove it, or add an aggregate whose persistedAs needs kind: ${p.kind}.`,
  "loom.file-field-needs-object-storage": (p: {
    name: unknown;
    ctxName: unknown;
    aggName: unknown;
    fileField: unknown;
  }) =>
    `Deployable '${p.name}' hosts aggregate '${p.ctxName}.${p.aggName}' ` +
    `which has a \`File\` field ('${p.fileField}'), but binds no object-store ` +
    `dataSource.  A \`File\` stores its bytes in an object store — declare a ` +
    `\`storage <s> { type: localDisk }\` (or \`s3\`), a ` +
    `\`dataSource <ds> { for: ${p.ctxName}, kind: objectStore, use: <s> }\`, and ` +
    `add '<ds>' to '${p.name}'\`s 'dataSources:' list.`,
  "loom.saving-shape-unsupported": (p: {
    name: unknown;
    platform: unknown;
    ctxName: unknown;
    aggName: unknown;
    shape: unknown;
    supported: unknown;
  }) =>
    `Deployable '${p.name}' (platform ${p.platform}) hosts aggregate ` +
    `'${p.ctxName}.${p.aggName}' with shape(${p.shape}), but that backend can only ` +
    `emit: ${p.supported}.  Use a supported shape, or host this ` +
    `aggregate on a deployable whose platform emits shape(${p.shape}).`,
  "loom.vanilla-document-unsupported": (p: { ctxName: unknown; name: unknown; bits: unknown }) =>
    `aggregate '${p.ctxName}.${p.name}' is shape: document on elixir, which emits ` +
    `scalar custom finds + named operations but not ${p.bits} ` +
    `(audited returning / provenanced ops, collection mutation, value-object/derived/` +
    `function reads, or non-scalar find predicates). Simplify them to scalar form, host this ` +
    `aggregate on a backend with full document support (node / dotnet / python / java), ` +
    `or use shape: relational / shape: embedded.`,
  "loom.vanilla-op-call-position": (p: {
    ctxName: unknown;
    name: unknown;
    opName: unknown;
    eName: unknown;
  }) =>
    `operation '${p.ctxName}.${p.name}.${p.opName}' calls sibling operation ` +
    `'${p.eName}' outside 'return' tail position, which the elixir backend can't ` +
    `lower — an operation compiles to a context function returning a tagged ` +
    `{:ok,_}|{:error,_} tuple, so its result can only be passed through as the ` +
    `whole 'return' value, not composed into a larger expression or bound with ` +
    `'let'. Use a bare 'return ${p.eName}(...)', or host this context on a backend ` +
    `with full support (node / dotnet / python / java).`,
  "loom.java-workflow-instance-field-unsupported": (p: {
    name: unknown;
    ctxName: unknown;
    wfName: unknown;
    fName: unknown;
  }) =>
    `Deployable '${p.name}' (platform java) hosts workflow '${p.ctxName}.${p.wfName}' with ` +
    `instance-view field '${p.fName}' of entity type — workflow-instance read models on the ` +
    `java backend do not yet emit a '<Part>Response' DTO. Drop the field from the observable ` +
    `state, or host it on a node / dotnet / python deployable.`,
  "loom.java-projection-field-unsupported": (p: {
    name: unknown;
    ctxName: unknown;
    projName: unknown;
    fName: unknown;
  }) =>
    `Deployable '${p.name}' (platform java) hosts projection '${p.ctxName}.${p.projName}' with ` +
    `row field '${p.fName}' of entity type — projection read models on the java backend do not ` +
    `yet emit a '<Part>Response' DTO. Drop the field, or host it on a node / dotnet / python ` +
    `deployable.`,
  "loom.context-filter-unsupported#no-auth-user": (p: {
    name: unknown;
    platform: unknown;
    ctxName: unknown;
    aggName: unknown;
  }) =>
    `Deployable '${p.name}' (platform ${p.platform}) hosts aggregate ` +
    `'${p.ctxName}.${p.aggName}' with a 'filter' capability predicate that references ` +
    `currentUser (e.g. a tenancy filter), but the deployable has no auth — there is no ` +
    `request-scoped principal to scope reads by. Add 'auth: required' (and a system ` +
    `'user {}' block), or remove the principal-referencing filter.`,
  "loom.context-filter-unsupported#unsupported-predicate": (p: {
    name: unknown;
    platform: unknown;
    ctxName: unknown;
    aggName: unknown;
    reason: unknown;
    nonRelationalUnsupported: unknown;
  }) =>
    `Deployable '${p.name}' (platform ${p.platform}) hosts aggregate ` +
    `'${p.ctxName}.${p.aggName}' with a 'filter' capability predicate that ${p.reason}. ` +
    `Host this aggregate on a .NET deployable${
      p.nonRelationalUnsupported
    }, or remove the unsupported capability filter. ` +
    `Non-principal filters on relational aggregates (e.g. 'filter !this.isDeleted') are emitted.`,
  "loom.filter-bypass-unsupported": (p: {
    name: unknown;
    platform: unknown;
    site: unknown;
    ctxName: unknown;
    aggName: unknown;
  }) =>
    `Deployable '${p.name}' (platform ${p.platform}) serves ${p.site} on ` +
    `aggregate '${p.ctxName}.${p.aggName}' with an 'ignoring' filter-bypass clause, but ` +
    `this backend does not honor capability-filter bypass yet — the honoring backends are ` +
    `dotnet (EF 'IgnoreQueryFilters'), node (Drizzle), and elixir (Ecto). Host this read ` +
    `on a supported backend, or remove the 'ignoring' clause.`,
  "loom.filter-bypass-unknown-capability": (p: {
    site: unknown;
    ctxName: unknown;
    aggName: unknown;
    cap: unknown;
  }) =>
    `${p.site} on aggregate '${p.ctxName}.${p.aggName}' ignores ` +
    `capability '${p.cap}', but that aggregate does not implement '${p.cap}'. Implement it ` +
    `(with ${p.cap} / implements ${p.cap}) or correct the capability name in the 'ignoring' clause.`,
  "loom.filter-bypass-no-filter": (p: {
    site: unknown;
    ctxName: unknown;
    aggName: unknown;
    cap: unknown;
  }) =>
    `${p.site} on aggregate '${p.ctxName}.${p.aggName}' ignores ` +
    `capability '${p.cap}', but '${p.cap}' contributes no query-filter to bypass (it is a ` +
    `stamps-only / fields-only capability). Remove '${p.cap}' from the 'ignoring' clause.`,
  "loom.dapper-unsupported": (p: { name: unknown; subject: unknown; reason: unknown }) =>
    `Deployable '${p.name}' selects 'persistence: dapper', but ${p.subject} ${p.reason}. ` +
    `The Dapper adapter is at full parity with EF Core (M-T6.9); the only shapes it now ` +
    `rejects have no relational persistence mapping at all (efcore included) — restructure ` +
    `the model as the message suggests.`,
  "loom.mikroorm-unsupported": (p: { name: unknown; subject: unknown; reason: unknown }) =>
    `Deployable '${p.name}' selects 'persistence: mikroorm', but ${p.subject} ${p.reason}. ` +
    `The MikroORM adapter is at full parity with Drizzle (M-T6.9); the only shapes it now ` +
    `rejects have no relational persistence mapping at all (drizzle included) — restructure ` +
    `the model as the message suggests.`,
  "loom.find-predicate-unsupported": (p: {
    name: unknown;
    adapter: unknown;
    subject: unknown;
    label: unknown;
  }) =>
    `Deployable '${p.name}' selects 'persistence: ${p.adapter}', but ${p.subject} uses ` +
    `a predicate the ${p.adapter} adapter cannot lower to SQL: ${p.label}. ` +
    `The ${p.adapter} find-predicate subset is narrower than EF Core's — ` +
    `use 'persistence: efcore'/'drizzle', or restructure the predicate.`,
  "loom.resource-missing-capability": (p: {
    name: unknown;
    sourceType: unknown;
    missing: unknown;
    contextName: unknown;
    kind: unknown;
  }) =>
    `resource '${p.name}' (sourceType '${p.sourceType}') does not offer ` +
    `${p.missing} required by context ` +
    `'${p.contextName}' for kind '${p.kind}'.`,
  "loom.remote-api-op-unsupported": (p: {
    name: unknown;
    resourceName: unknown;
    operationId: unknown;
    apiName: unknown;
    depName: unknown;
    platform: unknown;
  }) =>
    `workflow '${p.name}' calls '${p.resourceName}.${p.operationId}' on the ` +
    `in-system api '${p.apiName}', but deployable '${p.depName}' (platform ` +
    `'${p.platform}') emits no typed client for it yet (M-T4.8 slices 3-5).  ` +
    `Use the untyped 'get'/'post' verbs over a 'storage restApi' binding until then.`,
  "loom.resource-api-unserved": (p: { name: unknown; apiName: unknown }) =>
    `resource '${p.name}' binds api '${p.apiName}', but no backend deployable serves it, ` +
    `so its address cannot be derived.  Add 'serves: ${p.apiName}' to the deployable that hosts it.`,
  "loom.resource-api-ambiguous-server": (p: {
    name: unknown;
    apiName: unknown;
    length: unknown;
    servers: unknown;
  }) =>
    `resource '${p.name}' binds api '${p.apiName}', which ${p.length} deployables serve ` +
    `(${p.servers}).  The caller's address would be ambiguous — ` +
    `have exactly one deployable serve it.`,
  "loom.resource-api-self-call": (p: { name: unknown; rName: unknown; apiName: unknown }) =>
    `deployable '${p.name}' wires resource '${p.rName}', which binds api '${p.apiName}' that ` +
    `'${p.name}' itself serves.  Call the context directly instead — it is already in-process.`,
  "loom.resource-index-non-state": (p: { label: unknown; kind: unknown }) =>
    `${p.label}: \`index:\` needs a relational table to sit on, so it is only valid on a \`kind: state\` binding (this is \`kind: ${p.kind}\`).`,
  "loom.resource-index-unknown-entity": (p: {
    label: unknown;
    entity: unknown;
    contextName: unknown;
  }) =>
    `${p.label}: \`index:\` targets '${p.entity}', which is not an aggregate or contained part in context '${p.contextName}'.`,
  "loom.resource-index-unknown-column": (p: { label: unknown; entity: unknown; col: unknown }) =>
    `${p.label}: \`index:\` references '${p.entity}.${p.col}', but '${p.col}' is not a field on '${p.entity}'.`,
  "loom.config-key-unknown": (p: { label: unknown; key: unknown; sourceType: unknown }) =>
    `${p.label}: config key '${p.key}' is not recognised by sourceType '${p.sourceType}' — it will be ignored.`,
  "loom.config-key-type": (p: { label: unknown; key: unknown; expected: unknown }) =>
    `${p.label}: config key '${p.key}' expects ${p.expected}.`,
  "loom.config-key-required": (p: { label: unknown; name: unknown; sourceType: unknown }) =>
    `${p.label}: required config key '${p.name}' (sourceType '${p.sourceType}') is missing.`,
  "loom.tph-backend-unsupported": (p: {
    name: unknown;
    role: unknown;
    how: unknown;
    tphList: unknown;
    hostNote: unknown;
  }) =>
    `aggregate '${p.name}' (${p.role}) resolves to sharedTable (TPH) inheritance via ` +
    `${p.how}, but TPH storage emission is implemented for the ${p.tphList} backends only — ` +
    `${p.hostNote}. Host the context on one of those deployables, or declare ` +
    `'inheritanceUsing: ownTable' to use the per-concrete (TPC) layout (all backends). ` +
    `Tracked in aggregate-inheritance.md I2/I3.`,
  "loom.event-sourcing-backend-unsupported": (p: { name: unknown; hostNote: unknown }) =>
    `aggregate '${p.name}' is persistedAs: eventLog, but event-sourced storage emission ` +
    `is implemented for the Hono (node), .NET (dotnet), Java (java), Python (python) and elixir ` +
    `backends — ${p.hostNote}. Host the context on a supported deployable, or drop ` +
    `persistedAs: eventLog to use state persistence (all backends). ` +
    `Tracked in workflow-and-applier.md (appliers A2).`,
  "loom.event-sourced-workflow-unsupported": (p: { name: unknown; hosts: unknown }) =>
    `workflow '${p.name}' is eventSourced, but event-sourced workflow storage ` +
    `(a per-correlation event stream folded through its apply(...) blocks) is ` +
    `implemented on the Hono (node), .NET (dotnet), Python (FastAPI), Java (Spring) ` +
    `and elixir backends — this context is also hosted by ${p.hosts}. Host ` +
    `the context on a supported deployable, drop the eventSourced modifier ` +
    `to use a state-based saga (a persisted correlation-state row, supported on ` +
    `node / dotnet / java / python / elixir), or move the event-fold logic ` +
    `into an event-sourced aggregate (persistedAs: eventLog). ` +
    `Tracked in workflow-and-applier.md (A2-S5b).`,
  "loom.provenanced-backend-unsupported": (p: {
    name: unknown;
    names: unknown;
    hostNote: unknown;
  }) =>
    `aggregate '${p.name}' has provenanced field(s) ${p.names}, but the provenance runtime ` +
    `(trace capture + history) is emitted for the Hono (node), .NET (dotnet), Java (java), ` +
    `Python (python) and elixir backends only — ${p.hostNote}. Host ` +
    `the context on a node / dotnet / java / python / elixir deployable, or drop the 'provenanced' ` +
    `modifier to use a plain field (all backends). Tracked in provenance.md / ` +
    `type-system-feature-migration.md (DBT-1).`,
  "loom.field-mask-not-current-user": (p: { name: unknown; fName: unknown; offending: unknown }) =>
    `aggregate '${p.name}' field '${p.fName}': a \`mask unless\` predicate is evaluated ` +
    `at read projection as a param-free caller check, so it may only reference \`currentUser\` ` +
    `(and constants) — \`${p.offending}\` is not available here.`,
  "loom.field-mask-unsupported": (p: { name: unknown; names: unknown; unsupported: unknown }) =>
    `aggregate '${p.name}' has \`mask unless\` field(s) ${p.names}, but read-mask redaction ` +
    `is not emitted by the ${p.unsupported} backend(s) yet (node emits it; the other ` +
    `backends are the stacked follow-on). Drop the \`mask unless\` clause for those targets, ` +
    `or track authorization.md §5 (M-T3.2 item 6).`,
  "loom.field-mask-projection-source": (p: { name: unknown; src: unknown }) =>
    `projection '${p.name}' sources from aggregate '${p.src}', which has a \`mask unless\` ` +
    `field — query-time projection responses are not yet read-masked, so this would expose ` +
    `the masked field. Read the aggregate through its own routes, or drop the mask.`,
  "loom.audited-backend-unsupported": (p: {
    name: unknown;
    kind: unknown;
    names: unknown;
    capable: unknown;
    hostNote: unknown;
  }) =>
    `aggregate '${p.name}' has 'audited' ${p.kind}(s) ${p.names}, but per-operation ` +
    `audit-record emission for ${p.kind}s is implemented for the ${p.capable} backend(s) only — ${p.hostNote}. ` +
    `Host the context on a capable deployable, or drop the 'audited' modifier (all backends). ` +
    `Tracked in audit-and-logging.md.`,
  "loom.datasource-knob-unwired": (p: { name: unknown; property: unknown; description: unknown }) =>
    `resource '${p.name}' sets '${p.property}', but ${p.description}.  ` +
    `The value is accepted by validation and persisted in the IR but no current ` +
    `emitter consumes it — this is a no-op at runtime.`,
  "loom.user-duplicate-field": (p: { name: unknown; fName: unknown }) =>
    `system '${p.name}': user block declares field '${p.fName}' more than once.`,
  "loom.auth-no-user-block": (p: { name: unknown; sysName: unknown }) =>
    `deployable '${p.name}' has 'auth: required' but system '${p.sysName}' declares no 'user { ... }' block. ` +
    `Add a system-level user block describing the JWT claim shape (e.g. 'user { id: string, role: string }').`,
  "loom.duplicate-permission": (p: { name: unknown; pName: unknown }) =>
    `subdomain '${p.name}': permission '${p.pName}' is declared more than once.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/ui-checks.ts
  // ----------------------------------------------------------------------
  "loom.ui-projection-read-unsupported#not-ui-consumable": (p: {
    where: unknown;
    member: unknown;
    name: unknown;
  }) =>
    `${p.where}: reads projection '${p.member}' (\`${p.name}.${p.member}\`), which a ui ` +
    `cannot consume. Only an UNKEYED QUERY-TIME projection (no 'keyed by', a 'from … select' ` +
    `comprehension — whole-table singleton or 'group by' list) is readable from a page today. ` +
    `A keyed projection returns rows parameterised by key and a folded one is read by key off ` +
    `its materialized table; neither has a frontend client yet, so this would emit an ` +
    `unresolved receiver.`,
  "loom.unknown-page-element": (p: { where: unknown; name: unknown }) =>
    `${p.where}: \`${p.name}(…)\` names no walker primitive, component, value object, or ` +
    `\`extern\` function, so the frontend renders nothing for it — in a text slot the ` +
    `content is silently DROPPED (\`Text(${p.name}(…))\` emits an empty element).  Check the ` +
    `spelling, declare a \`component ${p.name}(…)\`, or import it as an \`extern\` function.`,
  "loom.frontend-collection-op-unsupported": (p: { where: unknown; op: unknown }) =>
    `${p.where}: uses the collection op \`.${p.op}\` on a collection in a page/component ` +
    `expression, but the frontend walker has no renderer for it — it emits verbatim ` +
    `(\`.${p.op}\`), so the generated project fails to compile (TS2339 on React/Vue/Svelte/` +
    `Angular, and the equivalent on Feliz/Flutter).  Collection ops are a backend ` +
    `vocabulary: compute the value server-side — a repository \`find\`, an aggregate ` +
    `\`derived\`, or a \`projection\` read model — and bind the result in the page.  ` +
    `(\`.map\` is the one op the frontends do render.)`,
  "loom.instance-effect-needs-route-id": (p: { name: unknown; route: unknown }) =>
    `page '${p.name}': \`match await …\` awaits an aggregate instance operation, which acts ` +
    `on the record identified by the page's route \`:id\` — but this page (route ` +
    `"${p.route}") declares no \`:id\` param, so no record is in scope.  Host the ` +
    `effect on a detail page (\`route: "/…/:id"\`), or drive the op through a form primitive ` +
    `(OperationForm).  M-T6.17.`,
  "loom.match-await-arg-mismatch": (p: {
    where: unknown;
    aggregate: unknown;
    op: unknown;
    length: unknown;
    sig: unknown;
    paramsLength: unknown;
    length2: unknown;
  }) =>
    `${p.where}: \`match await ${p.aggregate}.${p.op}(…)\` passes ${p.length} ` +
    `argument(s), but operation \`${p.op}(${p.sig})\` expects ${p.paramsLength} ` +
    `(${p.length2} required).  The awaited call's ` +
    `arguments build the request payload — a mismatch ships a broken request.  Pass one argument ` +
    `per parameter, in order.`,
  "loom.match-await-arg-type": (p: {
    where: unknown;
    aggregate: unknown;
    op: unknown;
    argFam: unknown;
    value: unknown;
    name: unknown;
    type: unknown;
    paramFam: unknown;
  }) =>
    `${p.where}: \`match await ${p.aggregate}.${p.op}(…)\` passes a ${p.argFam} ` +
    `literal (\`${p.value}\`) for parameter \`${p.name}: ${p.type}\` ` +
    `(a ${p.paramFam} type).  The argument encodes into the request payload — pass a ${p.paramFam} value.`,
  "loom.datagrid-selection-not-state": (p: { where: unknown; where2: unknown; label: unknown }) =>
    `${p.where}: DataGrid 'selection:' must name a \`String[]\` field declared in this ` +
    `${p.where2}'s \`state { }\` block, but ${p.label} ` +
    `isn't one. Declare \`state { selectedIds: String[] }\` and bind \`selection: selectedIds\`.`,
  "loom.datagrid-selection-not-array": (p: { where: unknown; name: unknown; t: unknown }) =>
    `${p.where}: DataGrid 'selection: ${p.name}' needs a \`String[]\` state field — ` +
    `the grid reports the selected rows' ids — but '${p.name}' is declared ` +
    `\`${p.t}\`. Change it to \`${p.name}: String[]\`.`,
  "loom.chart-kind-invalid": (p: { where: unknown; kind: unknown }) =>
    `${p.where}: Chart 'kind:' must be the string literal "line" or "bar"` +
    `${p.kind}. v1 ships exactly those two kinds; ` +
    `anything richer (pie, area, scatter) is an \`extern component\`.`,
  "loom.chart-of-not-grouped": (p: { where: unknown; why: unknown }) =>
    `${p.where}: Chart 'of:' — ${p.why}.`,
  "loom.chart-accessor-not-field#not-a-simple-accessor": (p: {
    where: unknown;
    slot: unknown;
    slot2: unknown;
  }) =>
    `${p.where}: Chart '${p.slot}:' must be a simple accessor lambda naming one row field ` +
    `(\`r => r.<field>\`) — the chart keys its ${p.slot2} ` +
    `on the field NAME, so a computed expression has nothing to key on.`,
  "loom.chart-accessor-not-field#not-a-row-field": (p: {
    where: unknown;
    slot: unknown;
    field: unknown;
    projName: unknown;
    wireShape: unknown;
  }) =>
    `${p.where}: Chart '${p.slot}: r => r.${p.field}' — '${p.field}' is not a declared row field ` +
    `of projection '${p.projName}' (declared: ${p.wireShape}).`,
  "loom.unresolved-action-ref#call-references-no-sibling": (p: { where: unknown; name: unknown }) =>
    `${p.where}: call \`${p.name}(…)\` references no sibling action and resolves to no ` +
    `function — declare an \`action ${p.name}(…)\` on this page/component, or fix the name.`,
  "loom.unresolved-action-ref#references-which-is-not": (p: {
    where: unknown;
    name: unknown;
    slot: unknown;
    argName: unknown;
  }) =>
    `${p.where}: \`${p.name} { ${p.slot}: ${p.argName} }\` references '${p.argName}', which is ` +
    `not a sibling action on this page/component — declare \`action ${p.argName}(…)\`, or fix the name.`,
  "loom.effect-in-lambda#effect": (p: { where: unknown; arrow: unknown; token: unknown }) =>
    `${p.where}: inline handler \`${p.arrow}\` performs an effect (\`${p.token}\`) in the page body. ` +
    `Only a named \`action\` may carry effects — declare one and reference it by name ` +
    `(e.g. \`action doIt(…) { … }\` then \`onClick: doIt\`). Render-tree lambdas must be pure.`,
  "loom.effect-in-lambda#remote-mutation": (p: {
    where: unknown;
    arrow: unknown;
    aggName: unknown;
    op: unknown;
  }) =>
    `${p.where}: inline handler \`${p.arrow}\` performs a remote mutation ` +
    `(\`${p.aggName}.${p.op}(…)\`) in the page body. Only a named \`action\` may carry ` +
    `effects — declare one and await the command so its Result is handled (e.g. ` +
    `\`action doIt(…) { match await ${p.aggName}.${p.op}(…) { … } }\` then \`onClick: doIt\`). ` +
    `Render-tree lambdas must be pure.`,
  "loom.action-op-has-params": (p: {
    where: unknown;
    name: unknown;
    opName: unknown;
    aggName: unknown;
    length: unknown;
    params: unknown;
  }) =>
    `${p.where}: \`Action(${p.name}.${p.opName})\` targets operation '${p.aggName}.${p.opName}', ` +
    `which takes ${p.length} parameter(s) (${p.params}). ` +
    `\`Action\` renders a one-shot button that submits no parameters, so they would be silently dropped. ` +
    `Use \`OperationForm(of: ${p.aggName}, op: ${p.opName})\` — it renders the parameter inputs.`,
  "loom.action-payload-mismatch#supplies-a-payload-value": (p: {
    where: unknown;
    name: unknown;
    handlerSlot: unknown;
    actionName: unknown;
  }) =>
    `${p.where}: \`${p.name} { ${p.handlerSlot}: ${p.actionName} }\` supplies a payload value, ` +
    `but action '${p.actionName}' is nullary — declare a single payload parameter to receive it.`,
  "loom.action-payload-mismatch#into-binding-arity": (p: {
    where: unknown;
    name: unknown;
    handlerSlot: unknown;
    actionName: unknown;
    arity: unknown;
    params: unknown;
  }) =>
    `${p.where}: \`${p.name} { ${p.handlerSlot}: ${p.actionName} }\` supplies no payload ` +
    `(two-way \`into:\` binding), but action '${p.actionName}' declares ${p.arity} parameter(s) ` +
    `(${p.params}) — make it nullary.`,
  "loom.action-payload-mismatch#action-referenced-by-declares": (p: {
    where: unknown;
    name: unknown;
    callName: unknown;
    handlerSlot: unknown;
    arity: unknown;
  }) =>
    `${p.where}: action '${p.name}' referenced by \`${p.callName} { ${p.handlerSlot}: … }\` ` +
    `declares ${p.arity} parameters; a handler action takes at most one payload parameter.`,
  "loom.method-call-unresolved-receiver": (p: {
    where: unknown;
    receiver: unknown;
    member: unknown;
    name: unknown;
  }) =>
    `${p.where}: method call \`${p.receiver}.${p.member}(…)\` has an ` +
    `unresolved receiver '${p.name}'. A method-call receiver must resolve to a page/component ` +
    `parameter, state / derived value, lambda binding, or a declared api handle ` +
    `(\`api <Handle>: <Api>\`). Declare the handle, or fix the reference.`,
  "loom.missing-effect-marker": (p: { where: unknown; aggName: unknown; op: unknown }) =>
    `${p.where}: action body calls \`${p.aggName}.${p.op}(…)\`, a remote mutating command on ` +
    `aggregate '${p.aggName}', with no effect marker — it has an invisible async boundary. Mark it ` +
    `\`match await ${p.aggName}.${p.op}(…) { … }\` so its Result is handled ` +
    `(async-actions-and-effects.md Stage 2b — every remote call is explicitly awaited and its ` +
    `Result matched).`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/tenancy-checks.ts
  // ----------------------------------------------------------------------
  "loom.tenant-registry-without-tenancy": (p: { agg: unknown; name: unknown }) =>
    `aggregate '${p.agg}' implements 'tenantRegistry' but system '${p.name}' declares no ` +
    `'tenancy by user.<claim> of <Registry>' line.  The registry tree (parent + dataKey) is ` +
    `only meaningful under a tenancy declaration — add it, or drop 'implements tenantRegistry'.`,
  "loom.tenancy-registry-duplicate": (p: {
    name: unknown;
    length: unknown;
    registries: unknown;
    registryName: unknown;
  }) =>
    `system '${p.name}' has ${p.length} aggregates implementing 'tenantRegistry' ` +
    `(${p.registries}); the tenant registry is singular — ` +
    `keep it on exactly one aggregate (the '${p.registryName}' named in 'tenancy by … of').`,
  "loom.tenancy-registry-not-target": (p: { agg: unknown; registryName: unknown }) =>
    `aggregate '${p.agg}' implements 'tenantRegistry' but the tenancy registry is ` +
    `'${p.registryName}' ('tenancy by … of ${p.registryName}').  The tree ` +
    `capability belongs on the registry itself — move 'implements tenantRegistry' onto ` +
    `'${p.registryName}'.`,
  "loom.policy-duplicate-target#read": (p: {
    name: unknown;
    aggregate: unknown;
    source: unknown;
  }) =>
    `policy in context '${p.name}' selects a read level for '${p.aggregate}' more ` +
    `than once (\`${p.source}\`); keep exactly one \`allow … on ${p.aggregate}\`.`,
  "loom.policy-duplicate-target#write": (p: {
    name: unknown;
    aggregate: unknown;
    source: unknown;
  }) =>
    `policy in context '${p.name}' selects a write level for '${p.aggregate}' more ` +
    `than once (\`${p.source}\`); keep exactly one \`allow write … on ${p.aggregate}\`.`,
  "loom.policy-unknown-aggregate#read": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` names '${p.aggregate}', which ` +
    `is not an aggregate in this context.  A read level scopes a tenant-owned aggregate ` +
    `declared in the same context.`,
  "loom.policy-unknown-aggregate#write": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` names '${p.aggregate}', which ` +
    `is not an aggregate in this context.  A write level scopes a tenant-owned aggregate ` +
    `declared in the same context.`,
  "loom.policy-target-not-tenant-owned#read": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` targets '${p.aggregate}', which ` +
    `is not \`with tenantOwned\`.  A read level refines the tenant floor, so it applies only ` +
    `to tenant-owned aggregates (crossTenant / unscoped / the registry have no tenant scope).`,
  "loom.policy-target-not-tenant-owned#write": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` targets '${p.aggregate}', which ` +
    `is not \`with tenantOwned\`.  A write level refines the tenant floor, so it applies only ` +
    `to tenant-owned aggregates.`,
  "loom.policy-level-requires-hierarchy#read": (p: {
    name: unknown;
    source: unknown;
    level: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` uses the '${p.level}' read level, ` +
    `which needs a tenant hierarchy — mark the registry \`implements tenantRegistry\` (the ` +
    `materialized-path tree).  Under flat tenancy only 'local' is defined (every org is its ` +
    `own root).`,
  "loom.policy-level-requires-hierarchy#write": (p: { name: unknown; source: unknown }) =>
    `policy in context '${p.name}': \`${p.source}\` uses the 'deep' write level, which ` +
    `needs a tenant hierarchy — mark the registry \`implements tenantRegistry\` (the ` +
    `materialized-path tree).  Under flat tenancy only 'local' is defined.`,
  "loom.policy-write-global-unsupported": (p: { name: unknown; source: unknown }) =>
    `policy in context '${p.name}': \`${p.source}\` uses \`write global\`, which is not ` +
    `offered — root-subtree-wide mutation is a footgun.  Use \`write deep\` (the caller's own ` +
    `subtree) or \`write local\` (the floor).  A caller can still \`allow global\` for READS.`,
  "loom.policy-write-wider-than-read": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
    readLevel: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` grants a wider WRITE scope than ` +
    `the READ scope for '${p.aggregate}' (read is '${p.readLevel}').  You cannot write ` +
    `what you cannot read — add \`allow deep on ${p.aggregate}\` (or \`allow global\`).`,
  "loom.policy-deny-duplicate": (p: {
    name: unknown;
    access: unknown;
    aggregate: unknown;
    source: unknown;
    access2: unknown;
  }) =>
    `policy in context '${p.name}' denies ${p.access} on '${p.aggregate}' more ` +
    `than once (\`${p.source}\`); one \`deny ${p.access2}` +
    `on ${p.aggregate}\` is total — keep exactly one.`,
  "loom.policy-deny-unknown-aggregate": (p: {
    name: unknown;
    source: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` names '${p.aggregate}', which ` +
    `is not an aggregate in this context.  A deny carve-out scopes an aggregate declared ` +
    `in the same context.`,
  "loom.policy-deny-shadows-allow": (p: {
    name: unknown;
    source: unknown;
    access: unknown;
    aggregate: unknown;
  }) =>
    `policy in context '${p.name}': \`${p.source}\` shadows an \`allow\` ${p.access} ` +
    `rule for '${p.aggregate}' — deny wins, so the allow is dead.  Remove the allow, or ` +
    `the deny if you meant to keep the grant.`,
  "loom.tenancy-claim-type-mismatch": (p: {
    name: unknown;
    claimField: unknown;
    claimType: unknown;
    registryName: unknown;
    idValueType: unknown;
    idValueType2: unknown;
  }) =>
    `system '${p.name}': tenancy claim 'user.${p.claimField}' is typed ` +
    `'${p.claimType}' but registry '${p.registryName}' has a ${p.idValueType} id. ` +
    `The derived registry self-scope filter compares ${p.registryName}.id to the claim, so ` +
    `declare the claim as '${p.claimField}: ${p.idValueType}'` +
    `${p.idValueType2}.`,
  "loom.tenant-owned-claim-type": (p: { name: unknown; claimField: unknown; claimType: unknown }) =>
    `system '${p.name}': tenancy claim 'user.${p.claimField}' is typed ` +
    `'${p.claimType}' but 'tenantOwned' provides 'tenantId: string' — the ` +
    `stamp/filter comparison mis-compiles typed backends.  Declare the claim as ` +
    `'${p.claimField}: string' (guid values round-trip as text).`,
  "loom.tenancy-conflicting-stance": (p: { name: unknown }) =>
    `aggregate '${p.name}' is marked both 'crossTenant' and 'with tenantOwned'; ` +
    `the stances are mutually exclusive — keep exactly one.`,
  "loom.tenant-owned-without-tenancy": (p: { name: unknown; sysName: unknown }) =>
    `aggregate '${p.name}' implements 'tenantOwned' but system '${p.sysName}' ` +
    `declares no 'tenancy by user.<claim> of <Registry>' line.  Add the tenancy ` +
    `declaration, or drop 'with tenantOwned'.`,
  "loom.cross-tenant-without-tenancy": (p: { name: unknown; sysName: unknown }) =>
    `aggregate '${p.name}' is marked 'crossTenant' but system '${p.sysName}' ` +
    `declares no 'tenancy by' line — there is no tenant scoping to opt out of, ` +
    `so the flag has no effect.`,
  "loom.tenancy-registry-marked": (p: { name: unknown; owned: unknown }) =>
    `aggregate '${p.name}' is the tenancy registry (named in ` +
    `'tenancy by ... of ${p.name}') and must not be marked ` +
    `${p.owned} — the registry is ` +
    `self-keyed; drop the marker.`,
  "loom.tenancy-stance-unmarked": (p: { name: unknown }) =>
    `aggregate '${p.name}' declares no tenancy stance; add ` +
    `\`with tenantOwned\` (tenant data) or \`crossTenant\` (shared data).`,
  "loom.unique-missing-tenant-scope": (p: { source: unknown; name: unknown; columns: unknown }) =>
    `\`${p.source}\` on tenant-owned aggregate '${p.name}' omits the tenant ` +
    `discriminator — this is a GLOBAL unique across all tenants. Did you mean ` +
    `\`unique (tenantId, ${p.columns})\`?`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/test-checks.ts
  // ----------------------------------------------------------------------
  "loom.aggregate-test-context": (p: { name: unknown; testName: unknown; reason: unknown }) =>
    `aggregate '${p.name}' test '${p.testName}': ${p.reason} ` +
    `Aggregate-level tests are bound to a value-object / pure-function context — they don't have a 'this' aggregate to mutate.  ` +
    `Move the operation invocation inside an aggregate operation or rewrite the test to assert via 'expect' / 'expect-throws'.`,
  "loom.integration-find-must-bind": (p: { name: unknown; testName: unknown }) =>
    `context '${p.name}' integration test '${p.testName}': a repository read inside ` +
    `'expect(...)' must be let-bound first — write \`let x = <Agg>.findById(...)\` then ` +
    `assert over \`x\` (the integration renderer awaits the read at statement level).`,
  "loom.e2e-unsupported-statement": (p: { name: unknown; badKind: unknown; magicId: unknown }) =>
    `e2e test '${p.name}': '${p.badKind}' is not supported in an e2e test body. ` +
    `Only expect, expect-throws, let, expression, and ${p.magicId}.<...> calls are allowed.`,
  "loom.e2e-unresolved-ref": (p: { testName: unknown; name: unknown }) =>
    `e2e test '${p.testName}': '${p.name}' is not a 'let' binding or a magic receiver ('api'/'ui'). ` +
    `An e2e body drives the deployable over HTTP, so it resolves no domain names — ` +
    `an enum value belongs there as its wire string (e.g. "${p.name}"). ` +
    `Emitting it verbatim would ship an undefined identifier in the generated test.`,
  "loom.e2e-unknown-workflow": (p: { magicId: unknown; method: unknown; known: unknown }) =>
    `e2e: unknown workflow '${p.magicId}.workflows.${p.method}' on this deployable. ` +
    `Available workflows: ${p.known}.`,
  "loom.e2e-unknown-method#projection": (p: {
    magicId: unknown;
    aggregateSlug: unknown;
    method: unknown;
  }) =>
    `e2e: unknown projection read '${p.magicId}.${p.aggregateSlug}.${p.method}'. ` +
    `A folded projection exposes: byKey, list.`,
  "loom.e2e-unknown-method#aggregate-verb": (p: {
    magicId: unknown;
    aggregateSlug: unknown;
    method: unknown;
    knownVerbs: unknown;
  }) =>
    `e2e: unknown method '${p.magicId}.${p.aggregateSlug}.${p.method}'. ` +
    `Available: ${p.knownVerbs}.`,
  "loom.e2e-unknown-aggregate": (p: { magicId: unknown; aggregateSlug: unknown; known: unknown }) =>
    `e2e: unknown aggregate '${p.magicId}.${p.aggregateSlug}' on this deployable. ` +
    `Available aggregates: ${p.known}.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/timer-checks.ts
  // ----------------------------------------------------------------------
  "loom.timer-event-shape#not-infrastructure-only": (p: {
    name: unknown;
    event: unknown;
    ctxName: unknown;
  }) =>
    `timerSource '${p.name}' fires '${p.event}', which is already emitted by domain logic in context '${p.ctxName}'. A timer's 'for:' event must be infrastructure-emitted only — declare a dedicated tick event (e.g. 'event ${p.event}Tick { at: datetime }').`,
  "loom.timer-event-shape#no-at-field": (p: { event: unknown; name: unknown }) =>
    `tick event '${p.event}' (fired by timerSource '${p.name}') has no 'at: datetime' field; the reacting workflow body cannot read the fire time.`,
  "loom.timer-needs-state#owner-binds-no-state": (p: { name: unknown; owner: unknown }) =>
    `timerSource '${p.name}' is owned by deployable '${p.owner}', whose platform binds no relational state. Single-fire delivery needs a Postgres advisory lock — host the context on a database-backed backend.`,
  "loom.timer-needs-state#context-has-no-db-owner": (p: { name: unknown; context: unknown }) =>
    `timerSource '${p.name}' fires an event in context '${p.context}', which no database-backed deployable owns. Single-fire delivery needs a Postgres advisory lock — host the context on a backend that binds a relational 'state' resource.`,
  "loom.timer-source-unbound": (p: { name: unknown; event: unknown }) =>
    `timerSource '${p.name}' fires '${p.event}', but no workflow reacts to it ('on(_: ${p.event})' / 'create(_: ${p.event}) by …'). The timer will run and emit into the void.`,

  // ----------------------------------------------------------------------
  // src/ir/validate/checks/workflow-checks.ts
  // ----------------------------------------------------------------------
  "loom.reactor-event-uncarried": (p: { name: unknown; label: unknown; event: unknown }) =>
    `workflow '${p.name}': ${p.label} subscribes to event '${p.event}', but no ` +
    `'channel' carries it. In-process dispatch is channel-routed, so this consumer never ` +
    `fires — declare a channel (e.g. 'channel C { carries: ${p.event} }') in the ` +
    `event's context.`,
  "loom.projection-event-uncarried": (p: { name: unknown; param: unknown; event: unknown }) =>
    `projection '${p.name}': on(${p.param}: ${p.event}) folds event '${p.event}', but ` +
    `no 'channel' carries it. In-process dispatch is channel-routed, so this fold never ` +
    `runs and the read-model row is never written — declare a channel (e.g. ` +
    `'channel C { carries: ${p.event} }') in the event's context.`,
  "loom.reactor-channel-ambiguous": (p: {
    name: unknown;
    label: unknown;
    event: unknown;
    length: unknown;
    carriers: unknown;
    carriers2: unknown;
  }) =>
    `workflow '${p.name}': ${p.label} subscribes to event '${p.event}', which is ` +
    `carried by ${p.length} channels (${p.carriers}). In-process dispatch ` +
    `records the first by declaration order ('${p.carriers2}') — carry '${p.event}' on a ` +
    `single channel to keep routing unambiguous.`,
  "loom.duplicate-workflow": (p: { name: unknown; wfName: unknown }) =>
    `context '${p.name}': workflow '${p.wfName}' is declared more than once.`,
  "loom.workflow-name-collision": (p: { name: unknown; wfName: unknown; clash: unknown }) =>
    `context '${p.name}': workflow '${p.wfName}' collides with the ${p.clash} of the same name.`,
  "loom.workflow-function-uses-state": (p: { ctxName: unknown; name: unknown; fnName: unknown }) =>
    `context '${p.ctxName}': workflow '${p.name}' function '${p.fnName}' reads the workflow's state (\`this\`). A workflow function is a pure helper over its parameters — pass the value in as an argument instead.`,
  "loom.canonical-create-duplicate-workflow": (p: { name: unknown; length: unknown }) =>
    `workflow '${p.name}' declares ${p.length} unnamed 'create' starters; ` +
    `at most one canonical create is allowed. Name the additional entry points (e.g. 'create byImport(...)').`,
  "loom.create-name-conflict-workflow": (p: { name: unknown; count: unknown; name2: unknown }) =>
    `workflow '${p.name}' declares ${p.count} 'create' starters named '${p.name2}'; ` +
    `create names must be unique within a workflow.`,
  "loom.event-create-overlap-workflow": (p: { name: unknown; count: unknown; event: unknown }) =>
    `workflow '${p.name}' declares ${p.count} event-triggered 'create' starters on event ` +
    `'${p.event}'; an event may start at most one create per workflow (the runtime can't ` +
    `choose which instance to allocate).`,
  "loom.workflow-correlation-required": (p: { name: unknown }) =>
    `workflow '${p.name}' has event consumers (reactors / event-triggered creates) but no ` +
    `correlation field. Declare one id-shaped state field (e.g. 'orderId: Order id') for the ` +
    `runtime to route inbound events to.`,
  "loom.correlation-field-ambiguous": (p: { name: unknown; length: unknown; idFields: unknown }) =>
    `workflow '${p.name}' has ${p.length} id-shaped state fields ` +
    `(${p.idFields}); the correlation field can't be inferred. ` +
    `A workflow with event consumers must declare exactly one id-shaped field.`,
  "loom.correlation-type-mismatch": (p: {
    name: unknown;
    label: unknown;
    byTarget: unknown;
    corrName: unknown;
    corrTarget: unknown;
  }) =>
    `workflow '${p.name}': the 'by' expression on ${p.label} yields ` +
    `${p.byTarget}, but the correlation field ` +
    `'${p.corrName}' is '${p.corrTarget} id'. A 'by' clause must route by the correlation field's type.`,
  "loom.correlation-uninferrable": (p: {
    name: unknown;
    label: unknown;
    event: unknown;
    corrName: unknown;
  }) =>
    `workflow '${p.name}': ${p.label} omits 'by' but event '${p.event}' has no ` +
    `field named '${p.corrName}' to infer routing from. Add a 'by <expr>' clause.`,
  "loom.workflow-unknown-name": (p: { name: unknown; kind: unknown; exprName: unknown }) =>
    `workflow '${p.name}': ${p.kind} references unknown name '${p.exprName}'.`,
  "loom.workflow-emit-unknown-event": (p: { name: unknown; eventName: unknown }) =>
    `workflow '${p.name}': emit refers to unknown event '${p.eventName}'.`,
  "loom.workflow-emit-missing-field": (p: { name: unknown; evName: unknown; f: unknown }) =>
    `workflow '${p.name}': emit '${p.evName}' is missing field '${p.f}'.`,
  "loom.workflow-emit-unknown-field": (p: { name: unknown; evName: unknown; f: unknown }) =>
    `workflow '${p.name}': emit '${p.evName}' has unknown field '${p.f}'.`,
  "loom.workflow-create-unknown-aggregate": (p: { name: unknown; aggName: unknown }) =>
    `workflow '${p.name}': '${p.aggName}.create(...)' references unknown aggregate '${p.aggName}'.`,
  "loom.workflow-create-missing-field": (p: { name: unknown; aggName: unknown; r: unknown }) =>
    `workflow '${p.name}': '${p.aggName}.create(...)' is missing required field '${p.r}'.`,
  "loom.workflow-create-unknown-field": (p: { name: unknown; aggName: unknown; p: unknown }) =>
    `workflow '${p.name}': '${p.aggName}.create(...)' has unknown field '${p.p}'.`,
  "loom.workflow-unknown-repository": (p: { name: unknown; repoName: unknown; method: unknown }) =>
    `workflow '${p.name}': '${p.repoName}.${p.method}(...)' references unknown repository '${p.repoName}'.`,
  "loom.workflow-unknown-repository-method": (p: {
    name: unknown;
    repoName: unknown;
    method: unknown;
    finds: unknown;
  }) =>
    `workflow '${p.name}': repository '${p.repoName}' has no method '${p.method}'.  Available: getById, ${p.finds}.`,
  "loom.workflow-currentuser-find": (p: { name: unknown; repoName: unknown; method: unknown }) =>
    `workflow '${p.name}': '${p.repoName}.${p.method}(...)' references a currentUser-bound find, ` +
    `which workflows don't yet pass the user into.  Use 'getById' with an explicit id parameter, ` +
    `or call the user-aware find from the route layer instead.`,
  "loom.workflow-load-array-unsupported": (p: {
    name: unknown;
    repoName: unknown;
    method: unknown;
  }) =>
    `workflow '${p.name}': '${p.repoName}.${p.method}(...)' returns an array; v1 supports only single non-nullable aggregates.  Split iteration into a follow-up workflow or use getById.`,
  "loom.workflow-load-nullable-unsupported": (p: {
    name: unknown;
    repoName: unknown;
    method: unknown;
  }) =>
    `workflow '${p.name}': '${p.repoName}.${p.method}(...)' returns a nullable; v1 supports only single non-nullable aggregates.  Use getById (throws → 404) instead.`,
  "loom.workflow-run-unknown-repository#workflow-a-criterion-query": (p: {
    name: unknown;
    repoName: unknown;
  }) =>
    `workflow '${p.name}': a criterion query on '${p.repoName}' references unknown repository '${p.repoName}'.`,
  "loom.workflow-run-unknown-repository#workflow-run-references": (p: {
    name: unknown;
    repoName: unknown;
  }) =>
    `workflow '${p.name}': '${p.repoName}.run(...)' references unknown repository '${p.repoName}'.`,
  "loom.findall-unknown-criterion": (p: { name: unknown; repoName: unknown; critName: unknown }) =>
    `workflow '${p.name}': criterion query on '${p.repoName}' references unknown criterion '${p.critName}'.`,
  "loom.findall-criterion-mismatch": (p: {
    name: unknown;
    critName: unknown;
    candidate: unknown;
    repoName: unknown;
    aggName: unknown;
  }) =>
    `workflow '${p.name}': criterion '${p.critName}' is over '${p.candidate}', but the criterion query on '${p.repoName}' queries '${p.aggName}'.  It needs a criterion 'of ${p.aggName}'.`,
  "loom.findall-criterion-arity": (p: {
    name: unknown;
    critName: unknown;
    length: unknown;
    repoName: unknown;
    retrievalArgsLength: unknown;
  }) =>
    `workflow '${p.name}': criterion '${p.critName}' takes ${p.length} argument(s), but the criterion query on '${p.repoName}' passed ${p.retrievalArgsLength}.`,
  "loom.findall-no-page": (p: { name: unknown; critName: unknown; repoName: unknown }) =>
    `workflow '${p.name}': criterion query '${p.critName}' on '${p.repoName}' reads the full result set — an unbounded list read.  Supply 'page: { offset: 0, limit: N }' to bound it.`,
  "loom.workflow-run-unknown-retrieval": (p: {
    name: unknown;
    repoName: unknown;
    retrievalName: unknown;
  }) =>
    `workflow '${p.name}': '${p.repoName}.run(${p.retrievalName}(...))' references unknown retrieval '${p.retrievalName}'.`,
  "loom.workflow-run-retrieval-mismatch": (p: {
    name: unknown;
    retrievalName: unknown;
    target: unknown;
    repoName: unknown;
    aggName: unknown;
  }) =>
    `workflow '${p.name}': retrieval '${p.retrievalName}' is over '${p.target}', but '${p.repoName}' is a repository for '${p.aggName}'.`,
  "loom.workflow-foreach-source": (p: { name: unknown; var: unknown }) =>
    `workflow '${p.name}': 'for ${p.var} in ...' must iterate a 'let xs = Repo.run(...)' result (the only aggregate array in v1).`,
  "loom.workflow-foreach-unknown-binding#workflow-in-for-references": (p: {
    name: unknown;
    var: unknown;
    target: unknown;
    op: unknown;
  }) =>
    `workflow '${p.name}': in 'for ${p.var}', '${p.target}.${p.op}(...)' references unknown binding '${p.target}'.`,
  "loom.workflow-foreach-unknown-binding#workflow-in-if-let-references": (p: {
    name: unknown;
    var: unknown;
    target: unknown;
    op: unknown;
  }) =>
    `workflow '${p.name}': in 'if let ${p.var}', '${p.target}.${p.op}(...)' references unknown binding '${p.target}'.`,
  "loom.iflet-bad-source": (p: { name: unknown; var: unknown }) =>
    `workflow '${p.name}': 'if let ${p.var} = ...' must bind 'Repo.find(<Criterion>)' — the only optional source in v1.`,
  "loom.workflow-unknown-binding": (p: { name: unknown; target: unknown; op: unknown }) =>
    `workflow '${p.name}': '${p.target}.${p.op}(...)' references unknown let-binding '${p.target}', or '${p.target}' isn't bound to an aggregate.`,
  "loom.workflow-unknown-operation": (p: { name: unknown; aggName: unknown; op: unknown }) =>
    `workflow '${p.name}': aggregate '${p.aggName}' has no operation '${p.op}'.`,
  "loom.workflow-private-operation": (p: { name: unknown; aggName: unknown; opName: unknown }) =>
    `workflow '${p.name}': '${p.aggName}.${p.opName}' is private.  Workflows can only call public operations.`,
  "loom.workflow-eventsourced-assign": (p: { name: unknown; segments: unknown }) =>
    `workflow '${p.name}': an event-sourced workflow can't assign its own state directly ('${p.segments}').  Change state by emitting an event with a matching 'apply' clause.`,
  "loom.workflow-unrecognised-statement": (p: { name: unknown }) =>
    `workflow '${p.name}': statement isn't a recognised workflow form.  Allowed: precondition, let (factory / repo / scalar), name.op(args), emit, own-state assignment ('field := value').`,
  "loom.transactional-no-effect": (p: { name: unknown }) =>
    `workflow '${p.name}': declared 'transactional' but does not mutate any aggregate or emit any event — the keyword has no effect.`,
  "loom.isolation-requires-transactional": (p: { name: unknown; isolation: unknown }) =>
    `workflow '${p.name}': isolation level '${p.isolation}' requires the 'transactional' keyword.`,
  "loom.resource-verb-invalid": (p: {
    name: unknown;
    resourceName: unknown;
    verb: unknown;
    resourceKind: unknown;
    resourceKind2: unknown;
  }) =>
    `workflow '${p.name}': '${p.resourceName}.${p.verb}(...)' — '${p.verb}' is not a valid verb for a ${p.resourceKind} resource.  Available: ${p.resourceKind2}.`,
  "loom.resource-op-in-transaction": (p: { name: unknown; resourceName: unknown; verb: unknown }) =>
    `workflow '${p.name}': resource operation '${p.resourceName}.${p.verb}(...)' cannot run inside a transactional workflow — external effects don't roll back with the database transaction.  Move it out of the transactional span, or publish through an outbox.`,

  // ----------------------------------------------------------------------
  // src/language/ddd-validator.ts
  // ----------------------------------------------------------------------
  "loom.validator-check-crashed": (p: { name: unknown; message: unknown }) =>
    `Validator check '${p.name}' crashed and was skipped; the remaining checks still ran. (${p.message})`,
  "loom.duplicate-auth-block": (p: { name: unknown }) =>
    `system '${p.name}' declares more than one 'auth { ... }' block; keep just the first.`,
  "loom.subdomain-conflicting-urlstyle": (p: {
    name: unknown;
    style: unknown;
    sub: unknown;
    prior: unknown;
  }) =>
    `api '${p.name}' sets urlStyle '${p.style}' on subdomain '${p.sub}', which another api already surfaces as '${p.prior}'.  The first-declared style ('${p.prior}') wins; route slugs use it.`,
  // ----------------------------------------------------------------------
  // src/macros/expander.ts
  // ----------------------------------------------------------------------
  "loom.unknown-capability": (p: { cap: unknown }) =>
    `Unknown capability '${p.cap}' in 'implements'.`,
  "loom.version-field-collision": (p: { name: unknown; name2: unknown }) =>
    `field 'version' on aggregate '${p.name}' collides with Loom's optimistic-concurrency column, which is an 'int'. ` +
    `Rename this field (e.g. '${p.name2}Version'), or declare it 'version: int' if you meant the concurrency counter.`,
  "loom.unknown-macro#top-level": (p: { name: unknown; listMacroNames: unknown }) =>
    `Unknown macro or capability '${p.name}'.  Available macros: ${p.listMacroNames}.`,
  "loom.unknown-macro#nested": (p: {
    name: unknown;
    childName: unknown;
    listMacroNames: unknown;
  }) =>
    `Macro '${p.name}' invoked unknown macro '${p.childName}'.  ` +
    `Available: ${p.listMacroNames}.`,
  "loom.macro-target-mismatch": (p: { name: unknown; target: unknown; hostKind: unknown }) =>
    `Macro '${p.name}' targets '${p.target}' but was invoked on a '${p.hostKind}'.`,
  "loom.macro-threw#nested": (p: { childName: unknown; name: unknown; message: unknown }) =>
    `Macro '${p.childName}' (invoked from '${p.name}') threw: ${p.message}`,
  "loom.macro-threw#direct": (p: { name: unknown; message: unknown }) =>
    `Macro '${p.name}' threw during expansion: ${p.message}`,
  "loom.capability-host-invalid": (p: { name: unknown; hostKind: unknown }) =>
    `Capability '${p.name}' can only be applied to an aggregate or context (got '${p.hostKind}').  ` +
    "A capability is a pure mixin over domain state, not a UI or API concern.",
  "loom.macro-non-ast-result": (p: { v1: unknown }) =>
    `Macro returned a non-AST value (${p.v1}); expected an AST member or capability node.`,
  "loom.macro-escapes-host":
    "Macro emitted a node targeting a destination outside the host's subtree.  " +
    "Macros may only modify their host or its descendants (e.g. a context-level macro " +
    "may invoke an aggregate-level macro against an aggregate inside the context).",
  "loom.macro-arg-duplicate": (p: { name: unknown; macroName: unknown }) =>
    `Duplicate argument '${p.name}' in call to macro '${p.macroName}'.`,
  "loom.macro-arg-unknown": (p: { name: unknown; macroName: unknown; spec: unknown }) =>
    `Unknown argument '${p.name}' for macro '${p.macroName}'.  ` +
    `Declared parameters: ${p.spec}.`,
  "loom.macro-arg-missing": (p: { name: unknown; name2: unknown; kind: unknown }) =>
    `Macro '${p.name}' requires argument '${p.name2}' (kind=${p.kind}).`,
  "loom.macro-arg-unresolved-ref": (p: {
    argName: unknown;
    macroName: unknown;
    of: unknown;
    refText: unknown;
  }) =>
    `Argument '${p.argName}' to macro '${p.macroName}' references unknown ${p.of} '${p.refText}'.`,
  "loom.macro-arg-kind-mismatch": (p: { argName: unknown; macroName: unknown; kind: unknown }) =>
    `Argument '${p.argName}' to macro '${p.macroName}' expected kind '${p.kind}'.`,

  // ----------------------------------------------------------------------
  // src/api/evolve.ts
  // ----------------------------------------------------------------------
  "loom.ir-internal#snapshot-lowering": "Lowering failed before snapshot capture.",
  "loom.ir-internal#evolve-lowering": "Lowering the current source failed.",
  "loom.ir-internal#migration-derivation": (p: { message: unknown }) =>
    `Migration derivation failed: ${p.message}`,
  "loom.no-system":
    "Source has no `system` block — schema migrations and the wire contract are derived per system, so there is nothing to evolve yet.",

  // ----------------------------------------------------------------------
  // src/api/index.ts
  // ----------------------------------------------------------------------
  "loom.ir-internal#generation": (p: { err: unknown }) =>
    `IR phase failed before generation: ${p.err}`,
} satisfies Record<string, MessageEntry>;

type Catalog = typeof DIAGNOSTIC_MESSAGES;

/** Every key in the catalog — a `loom.*` code, optionally `#<slug>`-qualified. */
export type DiagnosticMessageKey = keyof Catalog;

/** The params a given key needs — none for a fixed-string entry. */
type ParamsOf<K extends DiagnosticMessageKey> = Catalog[K] extends (params: infer P) => string
  ? [params: P]
  : [];

/** Render the catalogued message for `key`. */
export function diagMessage<K extends DiagnosticMessageKey>(key: K, ...args: ParamsOf<K>): string {
  const entry = DIAGNOSTIC_MESSAGES[key] as MessageEntry;
  return typeof entry === "string" ? entry : (entry as (params: unknown) => string)(args[0]);
}

/** The bare `loom.*` code behind a (possibly `#<slug>`-qualified) catalog key —
 *  the value the call site attaches as the diagnostic's `code`. */
export function codeOfMessageKey(key: DiagnosticMessageKey): string {
  const hash = (key as string).indexOf("#");
  return hash === -1 ? (key as string) : (key as string).slice(0, hash);
}
