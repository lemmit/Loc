// -------------------------------------------------------------------------
// Principal-stamp and `requires`-guard-without-auth rejections — the two
// codes (plus the sibling `requires`-guard gate) that refuse a
// principal-reading construct on a deployable with no auth.  Split out of
// system-checks.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { platformFamily } from "../../../language/validators/data/platform-rules.js";
import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  SystemIR,
} from "../../types/loom-ir.js";
import { exprUsesCurrentUser } from "../../types/loom-ir.js";
import { walkExprDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Lifecycle-stamp rejections.
//
// TWO codes, neither backend-named.  The body reads only `dep.auth`,
// `sys.user` and `agg.persistedAs` — facts about the MODEL — and never
// consults a backend capability; the per-backend stamp mechanisms (Java
// `_stampOnCreate`, .NET EF `AuditableInterceptor`, node Hono
// `_stampOnCreate`, python pre-persist, Elixir Ecto `put_change`) only select
// a message noun.
//
// Both arms are permanent language rules, not gaps waiting on a port:
//
//   * a principal stamp on a deployable with no auth has NO PRINCIPAL TO READ.
//     No backend can implement that; the message says how to fix it (add
//     `auth: required`, or use a non-principal stamp).
//   * a stamp on an event-sourced aggregate contradicts the storage model —
//     stamps mutate state fields, and an event-sourced aggregate's state is
//     FOLDED FROM ITS EVENT STREAM.
//
// They stay SPLIT rather than merged into one `loom.stamp-invalid`: the two
// failures have different fixes, so a caller matching on identity must be able
// to tell them apart.  `-invalid` marks "impossible or refused", and a target
// name never belongs in a code identity — it becomes a lie the day that target
// supports it.
// ---------------------------------------------------------------------------

/** The noun for the missing request principal.  Elixir says "principal
 *  (request actor)"; every other family says "principal".  A message detail —
 *  deliberately NOT part of any code identity. */

const PRINCIPAL_NOUN: Readonly<Record<string, string>> = {
  elixir: "principal (request actor)",
};

/** Backend families whose deployables carry lifecycle stamps at all. */

const STAMP_FAMILIES: readonly string[] = ["java", "dotnet", "node", "python", "elixir"];

export function validateStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    const family = platformFamily(dep.platform);
    if (family === undefined || !STAMP_FAMILIES.includes(family)) continue;
    const principalNoun = PRINCIPAL_NOUN[family] ?? "principal";
    const authed = !!(dep.auth?.required && sys.user);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const stamps = enriched.contextStamps ?? [];
        if (stamps.length === 0) continue;
        const usesPrincipal = stamps.some((r) =>
          r.assignments.some((a) => exprUsesCurrentUser(a.value)),
        );
        if (usesPrincipal && !authed) {
          diags.push({
            severity: "error",
            message: diagMessage("loom.stamp-principal-without-auth", {
              dep: dep.name,
              family,
              ctxName,
              name: agg.name,
              principalNoun,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.stamp-principal-without-auth",
          });
        }
        if (enriched.persistedAs === "eventLog") {
          diags.push({
            severity: "error",
            message: diagMessage("loom.stamp-on-event-sourced-invalid", {
              dep: dep.name,
              family,
              ctxName,
              name: agg.name,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.stamp-on-event-sourced-invalid",
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A `requires` that reads `currentUser`, on a deployable with NO AUTH.
//
// The third sibling of a rule that already exists twice: a principal-reading
// `filter` is refused (`loom.context-filter-unsupported#no-auth-user`) and so
// is a principal-reading `stamp` (`loom.stamp-principal-without-auth`), for the
// same reason — with no auth there is no request-scoped principal, so the
// clause is not unimplemented, it is unimplementable.  The GUARD was missed,
// and it is the one that EMITS.
//
// Measured on `main` before adding this, from ordinary Loom (an `operation`
// carrying `requires currentUser.role == "editor"`, on a deployable with no
// `auth:` and no system `user {}`):
//
//   node    if (!(currentUser.role === "editor")) throw new ForbiddenError(…)
//           → tsc: error TS2304: Cannot find name 'currentUser'
//   python  if not (currentUser.role == "editor"):        ← `publish_doc` binds no such name
//   .NET    if (!(currentUser.Role == "editor"))          ← the handler holds only `_repo`
//   java    if (!(Objects.equals(currentUser.role(), …))) ← likewise in the service
//
// i.e. a FREE IDENTIFIER in the emitted source: the generated project does not
// compile.  `ddd parse` reported `0 error(s), 0 warning(s)`.
//
// WHY it comes out unbound is the part that also decides how to detect it.
// With no auth there is nothing for lowering to resolve `currentUser` against,
// so the ref lands as `refKind: "unknown"` carrying the source name — and each
// backend's renderer prints an unknown ref verbatim.  So the principal test
// here CANNOT be `exprUsesCurrentUser` alone: that asks for
// `refKind === "current-user"`, which is exactly the shape this case fails to
// produce.  Both spellings must count — the resolved one (a system that
// declares `user {}` while this deployable opts out of `auth:`) and the
// unresolved one (no auth anywhere).  Testing only the resolved kind reports
// the harmless half and misses the half that does not compile.
//
// Every principal-reading gate site is covered rather than just the one that
// was found: operation / create / destroy bodies, `find … requires`, and a
// query-time projection's `requires`.  Covering one site would repeat the
// original mistake — the filter and stamp rules were each written for the site
// in front of whoever wrote them, which is why the guard went missing.
// ---------------------------------------------------------------------------

/** Backend families that render a `requires` gate at all (the frontends
 *  consume the wire shape and run no domain guard). */

const GUARD_FAMILIES: readonly string[] = ["java", "dotnet", "node", "python", "elixir"];

/** True when this gate reads the request principal — under EITHER lowering.
 *  See the note above: with no auth the ref never resolves, so the
 *  `refKind`-only test is blind to precisely the failing case. */

function guardReadsPrincipal(e: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(e, (node) => {
    if (node.kind === "ref" && (node.refKind === "current-user" || node.name === "currentUser")) {
      found = true;
    }
  });
  return found;
}

export function validateGuardPrincipalWithoutAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    const family = platformFamily(dep.platform);
    if (family === undefined || !GUARD_FAMILIES.includes(family)) continue;
    // The same `authed` test the stamp and filter rules use: a deployable is
    // principal-bearing only when it opts in AND the system declares the
    // identity shape the claim is read off.
    if (dep.auth?.required && sys.user) continue;
    const principalNoun = PRINCIPAL_NOUN[family] ?? "principal";

    const report = (ctxName: string, site: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.guard-principal-without-auth", {
          dep: dep.name,
          family,
          ctxName,
          site,
          principalNoun,
        }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.guard-principal-without-auth",
      });
    };

    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        for (const [kind, actions] of [
          ["operation", agg.operations],
          ["create", agg.creates ?? []],
          ["destroy", agg.destroys ?? []],
        ] as const) {
          for (const op of actions) {
            const guarded = (op.statements ?? []).some(
              (s) => s.kind === "requires" && guardReadsPrincipal(s.expr),
            );
            // A canonical lifecycle action's synthesised `name` IS its keyword,
            // so this reads `create Doc.create` / `destroy Doc.archive` /
            // `operation Doc.publish` without a special case.
            if (guarded) report(ctxName, `${kind} ${agg.name}.${op.name}`);
          }
        }
      }
      for (const repo of ctx.repositories) {
        for (const f of repo.finds) {
          if (guardReadsPrincipal(f.requires)) report(ctxName, `find ${repo.name}.${f.name}`);
        }
      }
      // A query-time projection's gate is the twin of `FindIR.requires`, and
      // lives on its comprehension rather than on the projection itself.
      for (const p of ctx.projections ?? []) {
        if (guardReadsPrincipal(p.query?.requires)) report(ctxName, `projection ${p.name}`);
      }
    }
  }
}
