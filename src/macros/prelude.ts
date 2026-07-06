// Built-in capability prelude (typed-capabilities.md, Phase 3).
//
// Macros are delivered by *code* (registered in the macro registry at toolchain
// start), so any `.ddd` can use them with nothing declared.  A `capability` is
// delivered by *source* — the expander resolves a `with`/`implements` name
// against capability declarations it finds in the workspace AST.  To migrate a
// stdlib macro to a capability while keeping it available everywhere without the
// user hand-writing it, we ship a built-in "prelude": canonical capability
// declarations merged into the expander's per-document capability inventory (see
// `expander.ts`).  A user-declared capability of the same name wins (the prelude
// is a default, not an override).
//
// The capabilities are BUILT with the same AST factories the macros used (not
// parsed from source) so their nodes — crucially their cross-references — match
// the old macro output exactly.  A factory reference carries no `$refNode`, so a
// `createdBy: User id` whose `User` isn't declared fails resolution *silently*
// (no diagnostic; lowering reads the `$refText`) — identical to the macro, and
// unlike a parsed reference which would surface a "could not resolve" error.
//
// Pure-mixin only (fields + filter + stamp) — operations/structure stay macros.
// `auditable` collapses the former `auditable` (fields) + `audit` (stamps) macro
// pair into one co-located declaration.

import type { Capability, CapabilityMember } from "../language/generated/ast.js";
import { PRINCIPAL_TYPE_NAME } from "../util/principal.js";
import {
  binaryExpr,
  contextFilter,
  contextStamp,
  field,
  idRef,
  intLit,
  memberAccess,
  nameRef,
  not,
  primType,
  selfRef,
  thisRef,
} from "./api/index.js";
import { nowExpr } from "./api/ui-factories.js";

/** Assemble a `Capability` AST node from already-built members, wiring the
 * member `$container` triples (the factories wire each member's own subtree). */
function capability(name: string, members: CapabilityMember[]): Capability {
  const cap = { $type: "Capability", name, members } as unknown as Capability;
  members.forEach((m, i) => {
    const mm = m as { $container?: unknown; $containerProperty?: string; $containerIndex?: number };
    mm.$container = cap;
    mm.$containerProperty = "members";
    mm.$containerIndex = i;
  });
  return cap;
}

/** `capability auditable { createdAt/updatedAt/createdBy/updatedBy (managed) +
 * onCreate/onUpdate stamps }` — the typed successor to the former
 * `auditable` (fields) + `audit` (stamps) macro pair. */
function buildAuditable(): Capability {
  return capability("auditable", [
    field("createdAt", primType("datetime"), { access: "managed" }),
    field("updatedAt", primType("datetime"), { access: "managed" }),
    field("createdBy", idRef(PRINCIPAL_TYPE_NAME), { access: "managed" }),
    field("updatedBy", idRef(PRINCIPAL_TYPE_NAME), { access: "managed" }),
    ...contextStamp({
      onCreate: [
        { field: "createdAt", value: nowExpr() },
        { field: "createdBy", value: nameRef("currentUser") },
      ],
      onUpdate: [
        { field: "updatedAt", value: nowExpr() },
        { field: "updatedBy", value: nameRef("currentUser") },
      ],
    }),
  ] as CapabilityMember[]);
}

/** `capability softDeletable { isDeleted (internal) + deletedAt? (managed) +
 * filter !this.isDeleted }` — state + query filter, co-located.  The
 * `softDelete()`/`restore()` OPERATIONS stay in the `softDelete` macro (a
 * capability is a pure mixin); compose them: `with softDeletable, softDelete`. */
function buildSoftDeletable(): Capability {
  return capability("softDeletable", [
    field("isDeleted", primType("bool"), { access: "internal" }),
    field("deletedAt", primType("datetime", { optional: true }), { access: "managed" }),
    contextFilter(not(memberAccess(thisRef(), "isDeleted"))),
  ] as CapabilityMember[]);
}

/** `capability tenantOwned { tenantId (internal) + onCreate stamp from the
 * principal's claim + filter this.tenantId == currentUser.tenantId }` — the
 * tenant-data marker of multi-tenancy Phase 1a
 * (docs/plans/multi-tenancy-implementation.md, slice 1a.2).  Combines
 * `auditable`'s principal-stamp shape with `softDeletable`'s filter shape:
 * every read is scoped to the caller's tenant, every create is stamped with
 * it, and `internal` keeps `tenantId` out of client create/update inputs.
 *
 * NOTE: the stamp/filter claim field is hardcoded `tenantId` here — the
 * capability does NOT read the system's `tenancy by user.<claim>`
 * declaration.  That the declared claim actually is `tenantId` (and that a
 * `tenancy by` declaration exists at all) is verified by the slice-1a.3
 * tenancy validators, not by this capability. */
function buildTenantOwned(): Capability {
  return capability("tenantOwned", [
    field("tenantId", primType("string"), { access: "internal" }),
    ...contextStamp({
      onCreate: [{ field: "tenantId", value: memberAccess(nameRef("currentUser"), "tenantId") }],
    }),
    contextFilter(
      binaryExpr(
        memberAccess(thisRef(), "tenantId"),
        "==",
        memberAccess(nameRef("currentUser"), "tenantId"),
      ),
    ),
  ] as CapabilityMember[]);
}

/** `capability tenantRegistry { parent: Self id? (immutable) + dataKey: string?
 * (managed) }` — the tenant-registry TREE capability of multi-tenancy Phase 2
 * (docs/plans/multi-tenancy-phase2.md, slice P2.2).  The registry aggregate —
 * the `of <Registry>` target of `tenancy by user.<claim> of <Registry>` — opts
 * into hierarchy by carrying `implements tenantRegistry`, which PROVIDES:
 *
 *   - `parent: Self id?` — an immutable self-FK to another registry row
 *     (`Self` resolves to the host aggregate at expansion; null = root org).
 *     `immutable` keeps it settable at create (the signup bootstrap passes it)
 *     but frozen after — reparent is out of scope (immutable paths are what
 *     make `deep` a cheap prefix scan).
 *   - `dataKey: string?` — the managed materialized path (`root` → `<id>`,
 *     `child` → `<parent.dataKey>.<id>`).  `managed` keeps it off client
 *     create/update inputs; the value is computed server-side in the `signUp`
 *     create factory via a workflow-tier `repo-let` on the parent (the
 *     mechanism already exists — a capability is a pure mixin and cannot inject
 *     a repo-reading create body, so the author writes the factory; the
 *     capability only carries the fields).  Nullable so pre-tree registry rows
 *     (no path yet) and the non-destructive column ADD stay valid; the derived
 *     `currentUser.orgPath` accessor falls back to the tenancy claim when a
 *     row has no `dataKey`.
 *
 * The registry is self-keyed (stance `"registry"`, never `tenantOwned`), so it
 * carries no `tenantId` column and receives no tenant stamp/filter — only the
 * derived self-scope read filter (enrichments.ts).  `tenantRegistry` adds the
 * tree fields on top of that, and is verified structurally by the phase-⑦
 * tenancy checks (exactly one, on the `of` target, only under a `tenancy by`
 * system). */
function buildTenantRegistry(): Capability {
  return capability("tenantRegistry", [
    field("parent", selfRef({ optional: true }), { access: "immutable" }),
    field("dataKey", primType("string", { optional: true }), { access: "managed" }),
  ] as CapabilityMember[]);
}

/** `capability versioned { version: int token = 1 }` — the opt-in
 * optimistic-concurrency marker (optimistic-concurrency.md).  ONE synthetic
 * field: `version: int` with `token` access (echoed by the client on update as
 * a precondition, dropped from create/update editable bodies, present on every
 * read — the wire-projection matrix already routes `token` this way).  The
 * `= 1` default seeds new rows at version 1 and, mirrored onto the derived
 * `version INTEGER NOT NULL DEFAULT 1` state-table column
 * (`migrations-builder.ts`), keeps the schema add non-destructive.  Enforcement
 * (guarded write + 409 on version mismatch) is per-backend, gated on
 * `aggregateIsVersioned` (`src/ir/util/versioned-capability.ts`). */
function buildVersioned(): Capability {
  return capability("versioned", [
    field("version", primType("int"), { access: "token", default: intLit(1) }),
  ] as CapabilityMember[]);
}

let _cache: Map<string, Capability> | undefined;

/** The built-in capabilities, built once and cached for the process.  The
 * returned `Capability` nodes are never mutated — the expander deep-clones their
 * members into each implementing aggregate — so sharing one build across all
 * documents/builds is safe. */
export function builtinCapabilities(): Map<string, Capability> {
  if (!_cache) {
    _cache = new Map([
      ["auditable", buildAuditable()],
      ["softDeletable", buildSoftDeletable()],
      ["tenantOwned", buildTenantOwned()],
      ["tenantRegistry", buildTenantRegistry()],
      ["versioned", buildVersioned()],
    ]);
  }
  return _cache;
}
