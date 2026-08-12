// ---------------------------------------------------------------------------
// The `authz-filter` sentinel, desugared for the IN-APP filter path.
//
// An `authz-filter` node (M-T9.9) is a SENTINEL, not an expression: each
// backend's QUERY-FILTER translator intercepts it and renders its native
// column predicate (Drizzle operator tree / EF `false` / JPQL `1 = 0` /
// SQLAlchemy contradiction / Ecto fragment).  The shared expression dispatcher
// (`renderExprWith`) deliberately throws on it, so a backend that forgets to
// intercept fails loudly instead of silently dropping an authorization term.
//
// A `shape: document` aggregate has no query-filter translator to intercept
// with.  The whole tree is ONE opaque jsonb column, so node/java/python filter
// document reads IN-APP over the REHYDRATED domain instance — the tenant floor
// `this.tenantId == currentUser.tenantId` already renders through the ordinary
// expression path there.  The sentinel arrived at that same ordinary path and
// blew the invariant (pairwise finding F1: `shape: document` × `policy { allow
// … }` crashed codegen on node, java and python; .NET's EF `HasQueryFilter`
// intercepts it, and Elixir has no `document` shape at all).
//
// The fix is not a fourth per-backend translator.  Both sentinel decisions are
// expressible as ORDINARY `ExprIR` over the rehydrated row, and the row carries
// everything they need: `dataKey` and `tenantId` are `tenantOwned` fields, so on
// a document aggregate they live INSIDE the blob and are on the instance.  So
// this module lowers the sentinel to plain IR ONCE, and the three in-app render
// sites feed the result to their existing expression renderer — which already
// handles every node used here (`==`/`!=` against a null literal, `&&`/`||`,
// string `+`, and the `string.startsWith` intrinsic) on all three backends.
//
// Only the IN-APP (document) path desugars.  The relational and embedded paths
// keep their native column translators: a SQL `where` is strictly better than
// rehydrating every row to test a predicate, and `false` is not a legal
// standalone Drizzle/Ecto/SQLAlchemy predicate — which is why the sentinel
// exists in the first place.
// ---------------------------------------------------------------------------

import type { ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import {
  DATA_KEY_PATH_DELIMITER,
  deepScopeAnchorClaim,
  deepScopeTenantClaim,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";

const STRING_T: TypeIR = { kind: "primitive", name: "string" };
const OPT_STRING_T: TypeIR = { kind: "optional", inner: STRING_T };
const BOOL_T: TypeIR = { kind: "primitive", name: "bool" };

const NULL_LIT: ExprIR = { kind: "literal", lit: "null", value: "null" };

/** `currentUser.<claim>` as a resolved member node — rebuilt rather than reused
 *  from the sentinel so the claim NAMES come from the sentinel's own accessors
 *  ({@link deepScopeAnchorClaim} / {@link deepScopeTenantClaim}) and the shape
 *  is identical to the tenant-floor filter every backend already renders. */
function claim(name: string): ExprIR {
  const userShape: TypeIR = { kind: "entity", name: "__User__" };
  return {
    kind: "member",
    receiver: { kind: "ref", name: "currentUser", refKind: "current-user", type: userShape },
    member: name,
    receiverType: userShape,
    memberType: STRING_T,
  };
}

/** `this.<field>` on the filtered row.  The in-app render sites rebind `this`
 *  to the rehydrated instance's variable (`thisName`), so this is the same node
 *  shape `buildTenantFloorFilter` emits — nothing new to render. */
function rowField(aggName: string, field: string, memberType: TypeIR): ExprIR {
  return {
    kind: "member",
    receiver: { kind: "this" },
    member: field,
    receiverType: { kind: "entity", name: aggName },
    memberType,
  };
}

/**
 * `leftType`/`rightType` are NOT decoration here.  Java renders `==` on a
 * reference type as `Objects.equals(l, r)` and native `==` otherwise, keyed
 * off `leftType` — so an untyped string comparison emits a Java REFERENCE
 * comparison that compiles green and is silently wrong at runtime (two equal
 * paths from different rows would not match).  Every operand type this builds
 * is therefore spelled out, exactly as `buildTenantFloorFilter` spells its own.
 * A null-literal comparison keeps native `==`/`!=` on Java by its own
 * short-circuit, so typing it is harmless.
 */
function binary(
  op: "==" | "!=" | "&&" | "||" | "+",
  left: ExprIR,
  right: ExprIR,
  operandType?: TypeIR,
): ExprIR {
  return {
    kind: "binary",
    op,
    left,
    right,
    leftType: operandType,
    rightType: operandType,
    resultType: op === "+" ? STRING_T : BOOL_T,
  };
}

/**
 * The in-app form of a `scope` decision — `DEEP_SCOPE_SEMANTICS` verbatim,
 * evaluated over the rehydrated row instead of as a column predicate:
 *
 *   (R.dataKey != null
 *      && (R.dataKey == P.<anchor>                    -- the caller's own node
 *          || R.dataKey.startsWith(P.<anchor> + ".")))-- + all descendants
 *   || (R.dataKey == null                             -- legacy / principal-less
 *       && R.tenantId == P.<tenantClaim>)             --   degrade to the floor
 *
 * The delimiter-correct prefix is what keeps `org_a` from matching `org_ab`
 * (the SQL side spells the same thing as `LIKE anchor || '.%'`).  The null
 * branch is the same deliberate OR-fallback the SQL translators carry: a row
 * stamped before P2.3 has a NULL `dataKey` and would otherwise vanish from its
 * own tenant's reads.
 *
 * The receiver of `.startsWith` is typed as a bare `string` (not the field's
 * declared `string?`): the null guard has already narrowed it, and the
 * intrinsic table is keyed on the receiver's primitive name.
 */
function scopeInApp(e: ExprIR, aggName: string): ExprIR {
  const anchor = claim(deepScopeAnchorClaim(e));
  const dataKeyOpt = rowField(aggName, TENANT_OWNED_DATA_KEY_FIELD, OPT_STRING_T);
  const dataKeyStr = rowField(aggName, TENANT_OWNED_DATA_KEY_FIELD, STRING_T);
  const descendantPrefix: ExprIR = {
    kind: "method-call",
    receiver: dataKeyStr,
    member: "startsWith",
    args: [
      binary(
        "+",
        anchor,
        { kind: "literal", lit: "string", value: DATA_KEY_PATH_DELIMITER },
        STRING_T,
      ),
    ],
    receiverType: STRING_T,
    isCollectionOp: false,
  };
  const present = binary("&&", binary("!=", dataKeyOpt, NULL_LIT, OPT_STRING_T), {
    kind: "paren",
    inner: binary("||", binary("==", dataKeyStr, anchor, STRING_T), descendantPrefix, BOOL_T),
  });
  const legacyFloor = binary(
    "&&",
    binary("==", dataKeyOpt, NULL_LIT, OPT_STRING_T),
    binary(
      "==",
      rowField(aggName, TENANT_OWNED_TENANT_ID_FIELD, STRING_T),
      claim(deepScopeTenantClaim(e)),
      STRING_T,
    ),
    BOOL_T,
  );
  return binary(
    "||",
    { kind: "paren", inner: present },
    { kind: "paren", inner: legacyFloor },
    BOOL_T,
  );
}

/**
 * Rewrite every `authz-filter` sentinel in `e` into ordinary `ExprIR` that the
 * backends' existing expression renderers handle, for the IN-APP (document)
 * filter path.  Non-sentinel nodes are returned unchanged (identity, so a
 * filter without a sentinel keeps its exact node objects and emission stays
 * byte-identical).
 *
 * `deny` becomes the plain `false` literal.  It is a sentinel on the SQL side
 * only because a bare boolean is not a legal standalone Drizzle/Ecto/SQLAlchemy
 * predicate; in-app it is exactly a `false` conjunct, and the always-false
 * result — the aggregate reads as invisible — is the same one the column
 * translators produce.
 *
 * The walk recurses through the only positions a validated capability
 * predicate can nest one (`paren`, `unary`, `binary`); in practice enrichment
 * appends a sentinel as a whole `contextFilters` entry.
 */
export function desugarAuthzFilterInApp(e: ExprIR, aggName: string): ExprIR {
  switch (e.kind) {
    case "authz-filter":
      return e.filter.kind === "deny"
        ? { kind: "literal", lit: "bool", value: "false" }
        : scopeInApp(e, aggName);
    case "paren":
      return { ...e, inner: desugarAuthzFilterInApp(e.inner, aggName) };
    case "unary":
      return { ...e, operand: desugarAuthzFilterInApp(e.operand, aggName) };
    case "binary":
      return {
        ...e,
        left: desugarAuthzFilterInApp(e.left, aggName),
        right: desugarAuthzFilterInApp(e.right, aggName),
      };
    default:
      return e;
  }
}

/** True when `e` carries an `authz-filter` sentinel anywhere the in-app
 *  desugar reaches — i.e. when {@link desugarAuthzFilterInApp} would change it.
 *  Lets a caller keep its pre-existing emission path untouched for the ordinary
 *  case. */
export function hasAuthzFilter(e: ExprIR): boolean {
  switch (e.kind) {
    case "authz-filter":
      return true;
    case "paren":
      return hasAuthzFilter(e.inner);
    case "unary":
      return hasAuthzFilter(e.operand);
    case "binary":
      return hasAuthzFilter(e.left) || hasAuthzFilter(e.right);
    default:
      return false;
  }
}
