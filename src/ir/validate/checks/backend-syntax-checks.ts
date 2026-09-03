// -------------------------------------------------------------------------
// Narrow single-backend host-identifier / call-position syntax gates:
// elixir (vanilla) in-class operation self-call position, and java reserved
// identifiers (F2-ADP-7).  Split out of system-checks.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { platformFamily } from "../../../language/validators/data/platform-rules.js";
import { isJavaKeyword } from "../../../util/naming.js";
import type {
  BoundedContextIR,
  ExprIR,
  OperationIR,
  StmtIR,
  SystemIR,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

// ---------------------------------------------------------------------------
// In-class operation→operation self-call position on elixir (vanilla).
//
// An aggregate operation compiles to a context function `<op>_<agg>(record,
// params)` that returns a tagged `{:ok,_} | {:error,_}` tuple (exception-less.md
// — the same carrier the controller `case`s on).  A sibling-operation self-call
// can therefore only be PASSED THROUGH as the whole `return` value (the enclosing
// op returns the same tagged shape) — it cannot be composed into a larger
// expression or bound with `let`, because a tuple has no implicit unwrap in
// Elixir.  The other backends model an operation as a plain method returning its
// value directly, so they compose freely; on vanilla the non-tail case would
// silently emit a tuple into arithmetic / a struct field, so reject it up front.
// (A `function` self-call is unrestricted — functions are pure, arity-1, and
// return their value directly.)  Mirrors `loom.vanilla-document-unsupported`.
// ---------------------------------------------------------------------------

/** Is this expression a sibling-operation self-call (vs a pure `function` /
 *  value-object ctor / repo read)?  Operations — public and private — lower to
 *  the `private-operation` callKind. */

function isOperationSelfCall(e: ExprIR): e is ExprIR & { kind: "call" } {
  return e.kind === "call" && e.callKind === "private-operation";
}

/** Visit every expression a statement roots — the value-bearing arms only
 *  (mirrors the lowering's statement shapes); a bare `call` statement is itself
 *  a no-op op-call on vanilla and is handled there, so its receiver is not an
 *  expression to flag. */

function eachStmtExpr(s: StmtIR, visit: (e: ExprIR) => void): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(s.expr, visit);
      break;
    case "return":
    case "assign":
    case "add":
    case "remove":
      walkExpr(s.value, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
  }
}

export function validateElixirOpSelfCallPosition(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        for (const op of agg.operations as OperationIR[]) {
          for (const s of op.statements) {
            // The single allowed site: an op-call that IS the whole value of a
            // `return` (tail passthrough).  Every other occurrence is rejected.
            const allowed =
              s.kind === "return" && isOperationSelfCall(s.value) ? s.value : undefined;
            eachStmtExpr(s, (e) => {
              if (e === allowed || !isOperationSelfCall(e)) return;
              diags.push({
                severity: "error",
                code: "loom.vanilla-op-call-position",
                message: diagMessage("loom.vanilla-op-call-position", {
                  ctxName,
                  name: agg.name,
                  opName: op.name,
                  eName: e.name,
                }),
                source: `${sys.name}/${dep.name}`,
              });
            });
          }
        }
      }
    }
  }
}

// `shape: embedded` reference collections (`X id[]`) map on java: the jsonb
// id-array column rides a per-target `AttributeConverter`
// (`<Target>IdJsonListConverter`, emitted in domain.ids) that unwraps the
// `List<XId>` to its bare `value`s, so the Jackson FormatMapper serialises
// `["v1","v2"]` — the same physical jsonb shape .NET / node / elixir produce.
// Nested part-in-part containments (single AND collection) likewise map
// (`directParentOf`).  There is no gate: `loom.java-embedded-refcoll-unsupported`
// has no raise site, and `test/generator/java/generator-java-shapes.test.ts`
// pins that it is never raised.

// ---------------------------------------------------------------------------
// M-T6.36 — the two `loom.java-{workflow-instance,projection}-field-unsupported`
// gates USED TO LIVE HERE, and were retired 2026-08-31 as PHANTOMS.
//
// Both refused an ENTITY (containment-part) typed read-model field.  The
// mission asked for the refused shapes to be emitted; probing the premise on
// fresh `main` showed there is nothing to emit, because the shape is
// UNREACHABLE.  A part type resolves only inside its own aggregate
// (`src/language/ddd-scope.ts`), so `projection P { line: Line }` and
// `workflow W { line: Line }` both fail at phase ③ with `Could not resolve
// reference to NamedDecl named 'Line'` — on EVERY platform, before any
// java-specific check runs.  A backend-named code for a shape the language
// refuses is the M-T5.21 §Symptom 1 lie in its purest form: it made java read
// as uniquely limited and carried two rows in the open-gap register that
// nothing could ever drain.
//
// The emitters keep their `guardInstanceField` / `guardProjectionField` throws
// as internal invariants (that is what an unreachable arm should be), and
// `test/generator/java/generator-java-readmodel-gates.test.ts` now pins the
// unreachability at the scope layer — so if that rule ever widens, the gap
// becomes visible again as a test failure rather than as silent output.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F2-ADP-7 (java arm) — a `.ddd` name that is a JAVA RESERVED WORD.
//
// The SQL half of this was closed by M-T6.42/M-T6.43: `@Column(name = …)` runs
// through `hbIdent`, so a column called `case` is quoted.  The HOST-IDENTIFIER
// half was left bare — `src/generator/java/emit/entity.ts` emits `String case;`
// and `public String case() {`, and the DTO records emit
// `record TicketResponse(String case, int do, …)`.  `javac` rejects all of it,
// and codegen reports zero diagnostics, so the failure surfaces only in a
// compile tier.
//
// WHY THIS REFUSES INSTEAD OF ESCAPING (probed, not assumed).  The .NET arm
// escapes — `@case` is a C# VERBATIM IDENTIFIER: lexically the identifier
// `case`, so the emitted member name, and therefore the JSON property
// System.Text.Json derives from it, are byte-identical to today.  Java has no
// verbatim-identifier syntax (JLS §3.9: a keyword is never an identifier), so
// the only "escape" available is a RENAME — which is what `escapeJavaIdent`
// does for LOCALS (`case` → `case_`).  Renaming a DECLARED field renames the
// Java record component, and a record component name IS the Jackson property
// name: `{"case": …}` would silently become `{"case_": …}` on java and java
// only.  A wire divergence introduced to fix a compile error is a worse bug
// than the compile error, so the honest answer at this layer is to refuse the
// name while a java deployable hosts the declaration.
//
// SCOPED TO THE AXIS THE LIMITATION LIVES ON: it fires only for a context
// hosted by a `platform: java` deployable.  The same model on node / python /
// elixir / dotnet is untouched — `get case()`, `def case`, `field :case` and
// `@case` are all legal there.
// ---------------------------------------------------------------------------

/** Every `.ddd`-declared name in `ctx` that the java emitters put in a bare
 *  Java identifier position, as `[what, owner, name]`. */

function javaIdentifierPositions(ctx: BoundedContextIR): [string, string, string][] {
  const out: [string, string, string][] = [];
  const members = (owner: string, fields: { name: string }[], what: string): void => {
    for (const f of fields) out.push([what, owner, f.name]);
  };
  const action = (owner: string, op: OperationIR): void => {
    // The canonical `create` / `destroy` are unnamed — they emit as `create` /
    // `destroy`, never as a `.ddd` name, so only their PARAMS are at risk.
    if (!op.canonical) out.push(["operation", owner, op.name]);
    for (const p of op.params) out.push(["parameter", `${owner}.${op.name}`, p.name]);
  };
  for (const agg of ctx.aggregates) {
    members(agg.name, agg.fields, "field");
    members(agg.name, agg.contains, "containment");
    members(agg.name, agg.derived, "derived field");
    for (const fn of agg.functions) {
      out.push(["function", agg.name, fn.name]);
      for (const p of fn.params) out.push(["parameter", `${agg.name}.${fn.name}`, p.name]);
    }
    for (const op of [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])])
      action(agg.name, op);
    for (const part of agg.parts) {
      members(`${agg.name}.${part.name}`, part.fields, "field");
      members(`${agg.name}.${part.name}`, part.contains, "containment");
      members(`${agg.name}.${part.name}`, part.derived, "derived field");
    }
  }
  for (const vo of ctx.valueObjects) {
    members(vo.name, vo.fields, "field");
    members(vo.name, vo.derived, "derived field");
  }
  for (const ev of ctx.events) members(ev.name, ev.fields, "field");
  for (const proj of ctx.projections) {
    members(proj.name, proj.stateFields, "field");
    for (const p of proj.params) out.push(["parameter", proj.name, p.name]);
  }
  for (const wf of ctx.workflows) {
    members(wf.name, wf.stateFields ?? [], "field");
    for (const p of wf.params) out.push(["parameter", wf.name, p.name]);
  }
  return out;
}

export function validateJavaReservedIdentifiers(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  // One diagnostic per offending NAME, not per hosting deployable — two java
  // deployables serving the same context describe one defect, not two.
  const seen = new Set<string>();
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const [what, owner, name] of javaIdentifierPositions(ctx)) {
        if (!isJavaKeyword(name)) continue;
        const key = `${ctxName}/${owner}/${what}/${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diags.push({
          severity: "error",
          message: diagMessage("loom.java-reserved-identifier-unsupported", {
            what,
            owner,
            name,
            ctxName,
          }),
          source: `${sys.name}/${ctxName}/${owner}`,
          code: "loom.java-reserved-identifier-unsupported",
        });
      }
    }
  }
}
