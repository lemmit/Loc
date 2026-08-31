import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// The EXPRESSION-SITE CENSUS — every (declaration, field) pair in the Loom IR
// that can transitively carry an `ExprIR`.
//
// WHY IT EXISTS.  Eleven modules under `src/ir/validate/checks/` and
// `src/ir/enrich/` walk the model's expression-bearing sites, and each one
// rolls its own outer loop.  They disagree about which sites exist:
// `validateExprIntegrity` — the check whose NAME claims the whole surface —
// reaches workflows, operations, appliers, invariants, derived and functions,
// and reaches no ui page, find, projection, criterion, domain service, handler
// or test.  So "does this check reach every expression" has no answer anywhere
// in the tree, and a check that reads as total is silently partial.  A partial
// walk is how a tenancy filter or an unresolved ref survives review.
//
// The missing thing is a DENOMINATOR.  This module computes one from the IR's
// own type declarations: a field is an expression site when its type
// transitively reaches `ExprIR`.  That makes the census a function of
// `loom-ir.ts` rather than a list someone maintains — the same reason
// `gate-ledger.ts` derives instead of storing, and the reason
// `gated-features-inventory.md` rotted.
//
// SYNTACTIC, NOT TYPE-CHECKED, and deliberately so: it reads the declaration
// AST and follows named type references. That over-approximates in one
// direction only (a union arm that happens to name a type reaching `ExprIR`
// counts even if no value ever takes that arm) and never under-approximates,
// which is the safe direction for a completeness denominator — a site it
// invents costs an acknowledgement, a site it MISSES costs a silent gap, and
// this whole module exists because silent gaps are the expensive kind.
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dirname, "..", "..");
const IR_TYPES = join(REPO, "src", "ir", "types", "loom-ir.ts");

/** One field that can carry expressions. `owner` is the declaring interface /
 *  type-alias name, `field` the property name (without the `?`). */
export interface ExprSite {
  readonly owner: string;
  readonly field: string;
  /** Source text of the field's declared type, for the census report. */
  readonly type: string;
}

interface Decl {
  /** Property name → declared type node, for an interface / object-type alias. */
  readonly props: Map<string, ts.TypeNode>;
  /** Every named type this declaration references anywhere (including inside
   *  its property types) — the edges reachability follows. */
  readonly refs: Set<string>;
}

/** Every named type reference inside a type node, at any depth. */
function referencedNames(node: ts.TypeNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      const name = n.typeName;
      out.add(ts.isIdentifier(name) ? name.text : name.right.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Parse the IR type declarations into a name → shape map. */
function readDecls(): Map<string, Decl> {
  const src = ts.createSourceFile(
    IR_TYPES,
    readFileSync(IR_TYPES, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const decls = new Map<string, Decl>();

  const addMembers = (name: string, members: readonly ts.TypeElement[], extra: ts.Node[]): void => {
    const props = new Map<string, ts.TypeNode>();
    const refs = new Set<string>();
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.type || !m.name) continue;
      const key = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : undefined;
      if (!key) continue;
      props.set(key, m.type);
      for (const r of referencedNames(m.type)) refs.add(r);
    }
    for (const n of extra) {
      if (ts.isTypeNode(n)) for (const r of referencedNames(n)) refs.add(r);
    }
    // A name can be declared twice (interface merging); union the shapes rather
    // than letting the second declaration silently replace the first.
    const prev = decls.get(name);
    if (prev) {
      for (const [k, v] of props) prev.props.set(k, v);
      for (const r of refs) prev.refs.add(r);
      return;
    }
    decls.set(name, { props, refs });
  };

  for (const st of src.statements) {
    if (ts.isInterfaceDeclaration(st)) {
      // `extends` clauses are edges too — a base's expression sites belong to
      // the derived type.
      const heritage = (st.heritageClauses ?? []).flatMap((h) => [...h.types]);
      addMembers(st.name.text, st.members, heritage);
    } else if (ts.isTypeAliasDeclaration(st)) {
      const t = st.type;
      if (ts.isTypeLiteralNode(t)) {
        addMembers(st.name.text, t.members, []);
        continue;
      }
      // A union / intersection / array alias owns no properties of its own, but
      // its arms are edges — `ExprIR` itself is such an alias, and so is every
      // `X | Y` payload union whose arms carry expressions.
      const props = new Map<string, ts.TypeNode>();
      const refs = referencedNames(t);
      // An inline object arm inside a union (`{ kind: "x"; expr: ExprIR }`) has
      // no name of its own; fold its properties into the alias so a site
      // declared only there is still counted.
      const foldLiterals = (n: ts.Node): void => {
        if (ts.isTypeLiteralNode(n)) {
          for (const m of n.members) {
            if (ts.isPropertySignature(m) && m.type && m.name && ts.isIdentifier(m.name)) {
              props.set(m.name.text, m.type);
            }
          }
        }
        ts.forEachChild(n, foldLiterals);
      };
      foldLiterals(t);
      const prev = decls.get(st.name.text);
      if (prev) {
        for (const [k, v] of props) prev.props.set(k, v);
        for (const r of refs) prev.refs.add(r);
      } else decls.set(st.name.text, { props, refs });
    }
  }
  return decls;
}

/** Names whose reachability makes a field an expression site. `StmtIR` /
 *  `WorkflowStmtIR` are included because a statement is an expression
 *  CONTAINER — a walk that reaches the statement list reaches the expressions
 *  under it, and a walk that misses the list misses them all. */
const EXPR_ROOTS = ["ExprIR", "StmtIR", "WorkflowStmtIR"] as const;

/** Every declaration name that transitively reaches one of `EXPR_ROOTS`. */
function reachingDecls(decls: Map<string, Decl>): Set<string> {
  // Reverse reachability: start from the roots and walk edges backwards, so
  // one pass over the (small) graph settles it.
  const reverse = new Map<string, Set<string>>();
  for (const [name, d] of decls) {
    for (const r of d.refs) {
      if (!reverse.has(r)) reverse.set(r, new Set());
      reverse.get(r)?.add(name);
    }
  }
  const reaching = new Set<string>(EXPR_ROOTS);
  const queue: string[] = [...EXPR_ROOTS];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const dependant of reverse.get(cur) ?? []) {
      if (reaching.has(dependant)) continue;
      reaching.add(dependant);
      queue.push(dependant);
    }
  }
  return reaching;
}

/** The census: every (owner, field) whose declared type reaches an expression.
 *  Sorted, so the report and any pinned baseline are stable. */
export function exprSites(): ExprSite[] {
  const decls = readDecls();
  const reaching = reachingDecls(decls);
  const sites: ExprSite[] = [];
  for (const [owner, d] of decls) {
    for (const [field, type] of d.props) {
      const names = referencedNames(type);
      const carries = [...names].some((n) => reaching.has(n));
      if (carries) sites.push({ owner, field, type: type.getText().replace(/\s+/g, " ") });
    }
  }
  return sites.sort((a, b) => a.owner.localeCompare(b.owner) || a.field.localeCompare(b.field));
}

/** `Owner.field` — the stable site id used by registers and reports. */
export const siteId = (s: Pick<ExprSite, "owner" | "field">): string => `${s.owner}.${s.field}`;

/** The expression/statement unions themselves.  Their fields are the INTRA
 *  -expression recursion, and that half is already solved exhaustively by
 *  `src/ir/util/walk.ts` (`walkExprChildren` and friends switch on `kind` with
 *  a `never` default, so a new arm fails the build).  Splitting them out is
 *  what makes the remaining number mean something: it is the size of the OUTER
 *  loop — the walk over declarations that reaches those expressions in the
 *  first place — which is the half nothing owns. */
const INTRA_EXPRESSION_OWNERS = new Set(["ExprIR", "StmtIR", "WorkflowStmtIR"]);

/** Census sites that live on a DECLARATION rather than inside an expression —
 *  the sites a model-wide enumeration has to reach. */
export const declarationExprSites = (): ExprSite[] =>
  exprSites().filter((s) => !INTRA_EXPRESSION_OWNERS.has(s.owner));
