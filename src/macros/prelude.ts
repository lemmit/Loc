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
import {
  contextFilter,
  contextStamp,
  field,
  idRef,
  memberAccess,
  nameRef,
  not,
  primType,
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
    field("createdBy", idRef("User"), { access: "managed" }),
    field("updatedBy", idRef("User"), { access: "managed" }),
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
    ]);
  }
  return _cache;
}
