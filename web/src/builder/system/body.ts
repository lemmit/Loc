import { AstUtils, CstUtils, GrammarUtils, type AstNode } from "langium";
import type {
  Aggregate,
  Apply,
  Create,
  Destroy,
  EmitStmt,
  ForStmt,
  FunctionDecl,
  HandleDecl,
  IfLetStmt,
  LetStmt,
  MatchStmt,
  Model,
  OnDecl,
  Operation,
  PreconditionStmt,
  RequiresStmt,
  ReturnStmt,
  Statement,
  ValueObject,
  VariantStmtArm,
  Workflow,
  WorkflowCreateDecl,
} from "../../../../src/language/generated/ast.js";
import { isWorkflowCreateDecl } from "../../../../src/language/generated/ast.js";
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";

// ---------------------------------------------------------------------------
// Shared statement-body editing for the Model builder, used by both operation
// bodies (aggregate members) and workflow bodies — both are `Statement[]`.
//
// Edits are pure text splices over a statement's (or a statement PART's) CST
// range, validated by re-parsing the whole document: an edit is committed only
// if the result still parses (`ifParses`).  Nothing outside the spliced range
// moves, so comments, blank lines and hand-spacing inside an edited construct
// survive byte-for-byte.  Semantic errors (unresolved names, type mismatches)
// surface in the Problems panel after the edit lands — they don't block the
// splice, since most expression-level names resolve in IR lowering, not as
// Langium cross-references.
//
// Statements are STRUCTURED per grammar form (`stmtView`): assignment, bare
// call, emit, let, return, precondition, requires, for, if-let and the
// effect-form match each get their own row shape; anything else keeps its
// verbatim source for a single text row.  Container forms (`for` / `if let` /
// `match`) carry their nested statement lists recursively, plus the SPANS of
// every editable part relative to the container's own source text — that is
// what lets a row rewrite one binder / one arm / one nested statement without
// reprinting the block it lives in.
// ---------------------------------------------------------------------------

/** Key of one statement-bearing member of a workflow or an aggregate.
 *  Workflows: `create` | `create:<Name>` | `handle:<Name>` | `on:<Event>` |
 *  `apply:<Event>`.  Aggregates: `op:<Name>` | `create` | `create:<Name>` |
 *  `destroy` | `destroy:<Name>` | `apply:<Event>`.  A `#<n>` suffix
 *  disambiguates a repeated key (two unnamed `destroy`s, say). */
export type BodyKey = string;

export type BodyLocator =
  // `member` addresses ONE statement-bearing member.  On a workflow it is a
  // `listBodies` key and defaults to the primary `create` starter; on an
  // aggregate it reaches the members an operation name cannot address —
  // `create` / `create:Name` / `destroy` / `destroy:Name` / `apply:Event` —
  // and, when omitted, `op` names the operation exactly as it always did.
  | { kind: "workflow"; name: string; member?: BodyKey }
  | { kind: "operation"; aggregate: string; op: string; member?: BodyKey };

/** Locator for ANY statement-bearing member of an aggregate, keyed the way
 *  `listBodies` reports it (`op:confirm`, `create`, `apply:Paid`, …).  `op` is
 *  carried alongside so the shape stays the historical `operation` locator —
 *  when the key names an operation both routes resolve to the same body. */
export function aggregateBody(aggregate: string, member: BodyKey): BodyLocator {
  return { kind: "operation", aggregate, op: member.startsWith("op:") ? member.slice(3) : member, member };
}

interface Body {
  owner: AstNode;
  statements: Statement[];
}

/** One statement-bearing member, for the body picker. */
export interface BodyRef {
  key: BodyKey;
  label: string;
  /** Number of statements in the member's body. */
  count: number;
}

function findAggregate(ast: Model, name: string): Aggregate | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Aggregate" && (n as Aggregate).name === name) return n as Aggregate;
  }
  return null;
}

function findWorkflow(ast: Model, name: string): Workflow | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "Workflow" && (n as Workflow).name === name) return n as Workflow;
  }
  return null;
}

/** A2-S5f: a workflow's SEQUENTIAL statements live in the primary `create(...)`
 *  starter (the unnamed, command-triggered one) — the default body the editor
 *  opens when no member key is given.  One definition, shared by every caller
 *  that used to re-implement `creates.find(c => !c.name) ?? creates[0]`
 *  (`body.ts`, `emit-event.ts`, `expr-slots.ts`). */
export function primaryWorkflowCreate(wf: Workflow): WorkflowCreateDecl | undefined {
  const creates = wf.members.filter(isWorkflowCreateDecl);
  return creates.find((c) => !c.name) ?? creates[0];
}

/** Statements of a workflow's primary `create` body (empty when it has none). */
export function primaryWorkflowStatements(wf: Workflow): Statement[] {
  return primaryWorkflowCreate(wf)?.body ?? [];
}

interface StmtHost extends Body {
  key: BodyKey;
  label: string;
}

/** Every statement-bearing member of a workflow, in declaration order:
 *  the primary + named `create`s, `handle`s, `on` reactors and `apply` folds. */
function workflowHosts(wf: Workflow): StmtHost[] {
  const out: StmtHost[] = [];
  const seen = new Map<string, number>();
  const push = (key: string, label: string, owner: AstNode, statements: Statement[]): void => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({ key: n === 0 ? key : `${key}#${n}`, label, owner, statements });
  };
  for (const m of wf.members) {
    if (isWorkflowCreateDecl(m)) {
      const c = m as WorkflowCreateDecl;
      push(c.name ? `create:${c.name}` : "create", c.name ? `create ${c.name}` : "create", c, c.body);
    } else if (m.$type === "HandleDecl") {
      const h = m as HandleDecl;
      push(`handle:${h.name}`, `handle ${h.name}`, h, h.body);
    } else if (m.$type === "OnDecl") {
      const o = m as OnDecl;
      const ev = o.event?.$refText ?? "";
      push(`on:${ev}`, `on ${ev}`, o, o.body);
    } else if (m.$type === "Apply") {
      const a = m as Apply;
      const ev = a.event?.$refText ?? "";
      push(`apply:${ev}`, `apply ${ev}`, a, a.body);
    }
  }
  return out;
}

/** Every statement-bearing member of an aggregate, in declaration order: its
 *  `operation`s (keyed `op:<name>`, as `listBodies` has always reported them)
 *  plus the lifecycle bodies an operation name cannot address — `create`s,
 *  `destroy`s and event `apply` folds. */
function aggregateHosts(agg: Aggregate): StmtHost[] {
  const out: StmtHost[] = [];
  const seen = new Map<string, number>();
  const push = (key: string, label: string, owner: AstNode, statements: Statement[]): void => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({ key: n === 0 ? key : `${key}#${n}`, label, owner, statements });
  };
  for (const m of agg.members) {
    if (m.$type === "Operation") {
      const o = m as Operation;
      push(`op:${o.name}`, `operation ${o.name}`, o, o.body);
    } else if (m.$type === "Create") {
      const c = m as Create;
      push(c.name ? `create:${c.name}` : "create", c.name ? `create ${c.name}` : "create", c, c.body);
    } else if (m.$type === "Destroy") {
      const d = m as Destroy;
      push(d.name ? `destroy:${d.name}` : "destroy", d.name ? `destroy ${d.name}` : "destroy", d, d.body);
    } else if (m.$type === "Apply") {
      const a = m as Apply;
      const ev = a.event?.$refText ?? "";
      push(`apply:${ev}`, `apply ${ev}`, a, a.body);
    }
  }
  return out;
}

/** Statement-bearing members addressable by a `BodyLocator.member` key —
 *  workflows expose their creates / handles / ons / applies; an aggregate its
 *  operations (`op:<name>`, also reachable by the bare `operation` locator)
 *  plus its `create` / `destroy` / `apply` lifecycle bodies. */
export function listBodies(node: AstNode): BodyRef[] {
  const hosts =
    node.$type === "Workflow"
      ? workflowHosts(node as Workflow)
      : node.$type === "Aggregate"
        ? aggregateHosts(node as Aggregate)
        : [];
  return hosts.map((h) => ({ key: h.key, label: h.label, count: h.statements.length }));
}

/** Statements of one workflow member, keyed (default: the primary `create`). */
export function workflowBodyStatements(wf: Workflow, member?: BodyKey): Statement[] {
  if (!member) return primaryWorkflowStatements(wf);
  return workflowHosts(wf).find((h) => h.key === member)?.statements ?? [];
}

/** Names bound by a workflow member's own signature — the `create`/`handle`
 *  parameter list, or the single `on`/`apply` event parameter. */
export function workflowBodyParamNames(wf: Workflow, member?: BodyKey): string[] {
  const host = member
    ? workflowHosts(wf).find((h) => h.key === member)?.owner
    : primaryWorkflowCreate(wf);
  if (!host) return [];
  if (host.$type === "WorkflowCreateDecl") return (host as WorkflowCreateDecl).params.map((p) => p.name);
  if (host.$type === "HandleDecl") return (host as HandleDecl).params.map((p) => p.name);
  if (host.$type === "OnDecl") return [(host as OnDecl).param];
  if (host.$type === "Apply") return [(host as Apply).param];
  return [];
}

function resolveBody(ast: Model, loc: BodyLocator): Body | null {
  if (loc.kind === "workflow") {
    const wf = findWorkflow(ast, loc.name);
    if (!wf) return null;
    const hosts = workflowHosts(wf);
    if (loc.member) return hosts.find((h) => h.key === loc.member) ?? null;
    // Default: the primary `create` starter (the historical single body).
    const create = primaryWorkflowCreate(wf);
    return create ? { owner: create, statements: create.body } : null;
  }
  const agg = findAggregate(ast, loc.aggregate);
  if (!agg) return null;
  // A member key reaches every statement-bearing member; without one, `op`
  // names an operation — the historical (and still exact) locator shape.
  if (loc.member) return aggregateHosts(agg).find((h) => h.key === loc.member) ?? null;
  const op = agg.members.find((m): m is Operation => m.$type === "Operation" && m.name === loc.op);
  return op ? { owner: op, statements: op.body } : null;
}

/** Statements of one aggregate member, keyed as `listBodies` reports it. */
export function aggregateBodyStatements(agg: AstNode, member: BodyKey): Statement[] {
  if (agg.$type !== "Aggregate") return [];
  return aggregateHosts(agg as Aggregate).find((h) => h.key === member)?.statements ?? [];
}

/** Names bound by an aggregate member's own signature — the operation /
 *  create / destroy parameter list, or an `apply`'s single event parameter. */
export function aggregateBodyParamNames(agg: AstNode, member: BodyKey): string[] {
  if (agg.$type !== "Aggregate") return [];
  const owner = aggregateHosts(agg as Aggregate).find((h) => h.key === member)?.owner;
  if (!owner) return [];
  if (owner.$type === "Apply") return [(owner as Apply).param];
  return (owner as Operation | Create | Destroy).params.map((p) => p.name);
}

/** Operation names declared on an aggregate (for the inspector's op picker). */
export function listOperations(node: AstNode): string[] {
  if (node.$type !== "Aggregate") return [];
  return (node as Aggregate).members
    .filter((m): m is Operation => m.$type === "Operation")
    .map((o) => o.name);
}

/** Each statement's verbatim source text. */
export function listStatements(ast: Model, loc: BodyLocator): string[] | null {
  const body = resolveBody(ast, loc);
  if (!body) return null;
  return body.statements.map((s) => s.$cstNode?.text ?? "");
}

// ---------------------------------------------------------------------------
// Statement views
// ---------------------------------------------------------------------------

/** A region of an enclosing statement's `src`, relative to its own start. */
export interface StmtSpan {
  at: number;
  len: number;
}

/** A nested statement list (a `for` body, an `if let` branch, a match arm) —
 *  the child rows plus everything a row needs to splice one of them, or a new
 *  one, into the enclosing statement's `src`. */
export interface StmtListView {
  items: StmtView[];
  /** `spans[i]` is `items[i]`'s region of the enclosing statement's `src`. */
  spans: StmtSpan[];
  /** Where a new statement is inserted in the enclosing statement's `src`. */
  insertAt: number;
  /** Indentation for an inserted statement. */
  indent: string;
  /** Indentation of the block's closing brace (used when the list is empty). */
  closeIndent: string;
}

export interface MatchArmView {
  variant: string;
  variantAt: StmtSpan;
  binder: string;
  /** Absent when the arm declares no binding (nothing to splice over). */
  binderAt?: StmtSpan;
  body: StmtListView;
}

// A statement structured for the body editor.  Every grammar form the DSL has
// gets its own row shape; `other` is the verbatim fallback for anything left
// (and for containers nested deeper than `MAX_STRUCTURED_DEPTH`).
export type StmtView =
  | { kind: "assign"; target: string; op: string; value: string }
  | { kind: "call"; head: string; args: string[] }
  | { kind: "emit"; event: string; fields: { name: string; value: string }[] }
  | { kind: "let"; name: string; value: string }
  | { kind: "return"; value: string }
  | { kind: "precondition"; expr: string; message?: string }
  | { kind: "requires"; expr: string }
  | {
      kind: "for";
      src: string;
      binder: string;
      binderAt: StmtSpan;
      iterable: string;
      iterableAt: StmtSpan;
      body: StmtListView;
    }
  | {
      kind: "ifLet";
      src: string;
      binder: string;
      binderAt: StmtSpan;
      subject: string;
      subjectAt: StmtSpan;
      then: StmtListView;
      /** Null when the `else { … }` clause is absent. */
      else: StmtListView | null;
    }
  | {
      kind: "match";
      src: string;
      subject: string;
      subjectAt: StmtSpan;
      arms: MatchArmView[];
      /** Span of each arm (for arm delete). */
      armSpans: StmtSpan[];
      /** Where a new arm is inserted, and at what indentation. */
      armInsertAt: number;
      armIndent: string;
      /** Null when the `else => …` clause is absent. */
      else: StmtListView | null;
    }
  | { kind: "other"; src: string };

/** Containers nested deeper than this render as a verbatim `other` row — a
 *  match inside a match arm inside a loop is a text edit, not a form. */
const MAX_STRUCTURED_DEPTH = 2;

const spanOf = (node: AstNode | undefined, base: number): StmtSpan | null => {
  const c = node?.$cstNode;
  return c ? { at: c.offset - base, len: c.end - c.offset } : null;
};

const propSpan = (node: AstNode, prop: string, base: number): StmtSpan | null => {
  const c = GrammarUtils.findNodeForProperty(node.$cstNode, prop);
  return c ? { at: c.offset - base, len: c.end - c.offset } : null;
};

const NO_SPAN: StmtSpan = { at: 0, len: 0 };
const text = (node: AstNode | undefined): string => node?.$cstNode?.text?.trim() ?? "";

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

/** `{` / `}` tokens the node's OWN rule contributes, in document order — the
 *  block delimiters of a `for` / `if let` / `match` / arm.  Langium wraps a
 *  rule's alternatives in unnamed group composites, so "direct child" is not a
 *  structural test; `astNode` identity is (a nested statement's braces belong
 *  to that statement, an object literal's to the literal). */
function directBraces(node: AstNode): { text: string; offset: number; end: number }[] {
  const cst = node.$cstNode;
  if (!cst) return [];
  const out: { text: string; offset: number; end: number }[] = [];
  for (const n of CstUtils.streamCst(cst)) {
    if (n.astNode !== node) continue;
    if (n.text === "{" || n.text === "}") out.push({ text: n.text, offset: n.offset, end: n.end });
  }
  return out;
}

/** Which nested statement list of a container statement a path step means. */
export type StmtList = "body" | "then" | "else" | { arm: number };

function subList(stmt: Statement, key: StmtList | undefined): Statement[] | null {
  if (stmt.$type === "ForStmt") return key === undefined || key === "body" ? (stmt as ForStmt).body : null;
  if (stmt.$type === "IfLetStmt") {
    const s = stmt as IfLetStmt;
    if (key === "else") return s.elseBody;
    return key === undefined || key === "then" || key === "body" ? s.thenBody : null;
  }
  if (stmt.$type === "MatchStmt") {
    const m = stmt as MatchStmt;
    if (key === "else") return m.elseBody;
    if (typeof key === "object") return m.varArms[key.arm]?.body ?? null;
    return null;
  }
  return null;
}

/** Absolute offsets of the `{ … }` delimiting a container's nested list. */
function blockOf(stmt: Statement, key: StmtList | undefined): { open: number; close: number } | null {
  if (stmt.$type === "ForStmt") {
    const b = directBraces(stmt);
    return b.length >= 2 ? { open: b[0]!.offset, close: b[1]!.offset } : null;
  }
  if (stmt.$type === "IfLetStmt") {
    const b = directBraces(stmt);
    if (key === "else") return b.length >= 4 ? { open: b[2]!.offset, close: b[3]!.offset } : null;
    return b.length >= 2 ? { open: b[0]!.offset, close: b[1]!.offset } : null;
  }
  if (stmt.$type === "MatchStmt") {
    const m = stmt as MatchStmt;
    if (typeof key === "object") {
      const arm = m.varArms[key.arm];
      if (!arm) return null;
      const b = directBraces(arm);
      return b.length >= 2 ? { open: b[0]!.offset, close: b[1]!.offset } : null;
    }
    if (key === "else") {
      // `match … { arms… else => { body } }` — the match's own braces are the
      // first and last; a BRACED else contributes the middle pair.
      const b = directBraces(m);
      return b.length >= 4 ? { open: b[1]!.offset, close: b[2]!.offset } : null;
    }
  }
  return null;
}

/** View of one nested statement list — child rows plus the spans/insertion
 *  point a row needs, all relative to the ENCLOSING statement's `src`. */
function blockListView(
  items: readonly Statement[],
  block: { open: number; close: number } | null,
  base: number,
  src: string,
  depth: number,
): StmtListView {
  const spans = items.map((s) => spanOf(s, base) ?? NO_SPAN);
  const last = spans[spans.length - 1];
  const closeRel = block ? block.close - base : src.length;
  return {
    items: items.map((s) => stmtView(s, depth + 1)),
    spans,
    insertAt: last ? last.at + last.len : closeRel,
    indent: last ? lineIndent(src, last.at) : `${lineIndent(src, closeRel)}  `,
    closeIndent: lineIndent(src, closeRel),
  };
}

function listView(
  stmt: Statement,
  key: StmtList | undefined,
  base: number,
  src: string,
  depth: number,
): StmtListView | null {
  const items = subList(stmt, key);
  return items ? blockListView(items, blockOf(stmt, key), base, src, depth) : null;
}

function armView(arm: VariantStmtArm, base: number, src: string, depth: number): MatchArmView {
  const binderAt = propSpan(arm, "binding", base);
  const braces = directBraces(arm);
  const block = braces.length >= 2 ? { open: braces[0]!.offset, close: braces[1]!.offset } : null;
  return {
    variant: text(arm.varType),
    variantAt: spanOf(arm.varType, base) ?? NO_SPAN,
    binder: arm.binding ?? "",
    ...(binderAt ? { binderAt } : {}),
    body: blockListView(arm.body, block, base, src, depth),
  };
}

function stmtView(s: Statement, depth = 0): StmtView {
  if (s.$type === "AssignOrCallStmt" && s.op && s.value) {
    return {
      kind: "assign",
      target: s.target.$cstNode?.text?.trim() ?? "",
      op: s.op,
      value: s.value.$cstNode?.text?.trim() ?? "",
    };
  }
  // Bare call: an LValue with a trailing call (`order.addLine(productId, qty)`),
  // no mutation suffix. The LValue carries the dotted head/tail + arg list.
  if (s.$type === "AssignOrCallStmt" && !s.op && !s.value && s.target.call) {
    return {
      kind: "call",
      head: [s.target.head, ...s.target.tail].join("."),
      args: s.target.args.map((a) => a.$cstNode?.text?.trim() ?? ""),
    };
  }
  if (s.$type === "EmitStmt") {
    const e = s as EmitStmt;
    return {
      kind: "emit",
      // `$refText` is the event name without triggering a linker deref (the
      // playground parse is unlinked).
      event: e.event?.$refText ?? "",
      fields: e.fields.map((f) => ({ name: f.name, value: f.value.$cstNode?.text?.trim() ?? "" })),
    };
  }
  if (s.$type === "LetStmt") {
    const l = s as LetStmt;
    return { kind: "let", name: l.name, value: text(l.expr) };
  }
  if (s.$type === "ReturnStmt") {
    return { kind: "return", value: text((s as ReturnStmt).value) };
  }
  if (s.$type === "PreconditionStmt") {
    const p = s as PreconditionStmt;
    return {
      kind: "precondition",
      expr: text(p.expr),
      ...(p.message !== undefined ? { message: p.message } : {}),
    };
  }
  if (s.$type === "RequiresStmt") {
    return { kind: "requires", expr: text((s as RequiresStmt).expr) };
  }

  const src = s.$cstNode?.text ?? "";
  const base = s.$cstNode?.offset ?? 0;
  if (depth < MAX_STRUCTURED_DEPTH) {
    if (s.$type === "ForStmt") {
      const f = s as ForStmt;
      return {
        kind: "for",
        src,
        binder: f.var,
        binderAt: propSpan(f, "var", base) ?? NO_SPAN,
        iterable: text(f.iterable),
        iterableAt: spanOf(f.iterable, base) ?? NO_SPAN,
        body: blockListView(f.body, blockOf(f, "body"), base, src, depth),
      };
    }
    if (s.$type === "IfLetStmt") {
      const il = s as IfLetStmt;
      const hasElse = directBraces(il).length >= 4;
      return {
        kind: "ifLet",
        src,
        binder: il.var,
        binderAt: propSpan(il, "var", base) ?? NO_SPAN,
        subject: text(il.source),
        subjectAt: spanOf(il.source, base) ?? NO_SPAN,
        then: blockListView(il.thenBody, blockOf(il, "then"), base, src, depth),
        else: hasElse ? listView(il, "else", base, src, depth) : null,
      };
    }
    if (s.$type === "MatchStmt") {
      const m = s as MatchStmt;
      const braces = directBraces(m);
      const armSpans = m.varArms.map((a) => spanOf(a, base) ?? NO_SPAN);
      const lastArm = armSpans[armSpans.length - 1];
      const openRel = braces.length > 0 ? braces[0]!.end - base : src.length;
      return {
        kind: "match",
        src,
        subject: text(m.subject),
        subjectAt: spanOf(m.subject, base) ?? NO_SPAN,
        arms: m.varArms.map((a) => armView(a, base, src, depth)),
        armSpans,
        armInsertAt: lastArm ? lastArm.at + lastArm.len : openRel,
        armIndent: lastArm ? lineIndent(src, lastArm.at) : "  ",
        else: braces.length >= 4 ? listView(m, "else", base, src, depth) : null,
      };
    }
  }
  return { kind: "other", src };
}

export function listStatementViews(ast: Model, loc: BodyLocator): StmtView[] | null {
  const body = resolveBody(ast, loc);
  if (!body) return null;
  return body.statements.map((s) => stmtView(s));
}

/** The source a row reconstructs for a view — the identity/`onEdit` payload. */
export function stmtText(v: StmtView): string {
  switch (v.kind) {
    case "assign":
      return `${v.target} ${v.op} ${v.value}`;
    case "call":
      return `${v.head}(${v.args.join(", ")})`;
    case "emit":
      return `emit ${v.event} { ${v.fields.map((f) => `${f.name}: ${f.value}`).join(", ")} }`;
    case "let":
      return `let ${v.name} = ${v.value}`;
    case "return":
      return `return ${v.value}`;
    case "precondition":
      return `precondition ${v.expr}${v.message !== undefined ? ` message ${JSON.stringify(v.message)}` : ""}`;
    case "requires":
      return `requires ${v.expr}`;
    default:
      return v.src;
  }
}

// --- local span splicing (what a container row commits through `onEdit`) ----

/** Replace `span` of `src` with `text` — the row-level twin of a CST splice. */
export function replaceSpan(src: string, span: StmtSpan, text: string): string {
  return src.slice(0, span.at) + text + src.slice(span.at + span.len);
}

/** Drop `span` from `src`, swallowing the line break + indentation before it
 *  and the separator after it (match arms are comma-separated; statements
 *  never are, so the comma scan is a no-op for them). */
export function removeSpan(src: string, span: StmtSpan): string {
  let start = span.at;
  while (start > 0 && (src[start - 1] === " " || src[start - 1] === "\t")) start--;
  if (start > 0 && src[start - 1] === "\n") start--;
  let end = span.at + span.len;
  let scan = end;
  while (scan < src.length && (src[scan] === " " || src[scan] === "\t")) scan++;
  if (src[scan] === ",") end = scan + 1;
  return src.slice(0, start) + src.slice(end);
}

/** Swap two non-overlapping spans' text in place (whitespace between stays). */
export function swapSpans(src: string, a: StmtSpan, b: StmtSpan): string {
  const [first, second] = a.at <= b.at ? [a, b] : [b, a];
  const ft = src.slice(first.at, first.at + first.len);
  const st = src.slice(second.at, second.at + second.len);
  return (
    src.slice(0, first.at) +
    st +
    src.slice(first.at + first.len, second.at) +
    ft +
    src.slice(second.at + second.len)
  );
}

/** Append an empty `<Variant> [binder] => { }` arm to a match view's `src`. */
export function insertMatchArm(
  src: string,
  view: Extract<StmtView, { kind: "match" }>,
  variant: string,
  binder?: string,
): string {
  const head = binder?.trim() ? `${variant.trim()} ${binder.trim()}` : variant.trim();
  const arm = `\n${view.armIndent}${head} => {\n${view.armIndent}}`;
  return src.slice(0, view.armInsertAt) + arm + src.slice(view.armInsertAt);
}

/** Append `stmt` to a nested list, opening the block when it is empty (the row
 *  twin of `addStatement`'s `openBlock` — same output, byte for byte). */
export function insertIntoList(src: string, list: StmtListView, stmt: string): string {
  const body = stmt.trim();
  if (list.spans.length > 0) {
    return src.slice(0, list.insertAt) + `\n${list.indent}${body}` + src.slice(list.insertAt);
  }
  let cut = list.insertAt;
  while (cut > 0 && (src[cut - 1] === " " || src[cut - 1] === "\t")) cut--;
  const onOwnLine = cut > 0 && src[cut - 1] === "\n";
  const opened = `${list.indent}${body}\n${list.closeIndent}`;
  return onOwnLine
    ? src.slice(0, cut) + opened + src.slice(list.insertAt)
    : src.slice(0, list.insertAt) + `\n${opened}` + src.slice(list.insertAt);
}

// --- function bodies (a single Expression, not Statement[]) ----------------

function membersOf(node: AstNode): readonly AstNode[] {
  if (node.$type === "Aggregate") return (node as Aggregate).members;
  if (node.$type === "ValueObject") return (node as ValueObject).members;
  return [];
}

/** Function names declared on an aggregate / value object. */
export function listFunctions(node: AstNode): string[] {
  return membersOf(node)
    .filter((m): m is FunctionDecl => m.$type === "FunctionDecl")
    .map((f) => f.name);
}

function findFunction(ast: Model, owner: string, fn: string): FunctionDecl | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (
      (n.$type === "Aggregate" || n.$type === "ValueObject") &&
      (n as Aggregate | ValueObject).name === owner
    ) {
      const f = membersOf(n).find(
        (m): m is FunctionDecl => m.$type === "FunctionDecl" && (m as FunctionDecl).name === fn,
      );
      if (f) return f;
    }
  }
  return null;
}

/** The function's body expression, verbatim from source. */
export function functionBody(ast: Model, owner: string, fn: string): string | null {
  return findFunction(ast, owner, fn)?.body?.$cstNode?.text ?? null;
}

export function editFunctionBody(source: string, owner: string, fn: string, text: string): string | null {
  const cst = findFunction(parseDdd(source).ast, owner, fn)?.body?.$cstNode;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: text.trim() }]));
}

/** Validate by re-parsing: return `candidate` only if it still parses. */
function ifParses(candidate: string): string | null {
  return parseDdd(candidate).parserErrors.length === 0 ? candidate : null;
}

// ---------------------------------------------------------------------------
// Statement addressing — a flat index for a top-level statement, or a path of
// steps for one nested inside a `for` / `if let` / `match` block.  Each step
// names the enclosing container's sub-list to descend into (omitted at the top
// level, and for a container with only one list).
// ---------------------------------------------------------------------------

export interface StmtStep {
  index: number;
  list?: StmtList;
}
export type StmtPath = readonly StmtStep[];
export type StmtAddr = number | StmtPath;

const asPath = (addr: StmtAddr): StmtPath => (typeof addr === "number" ? [{ index: addr }] : addr);

interface StmtSite {
  /** The list the addressed statement lives in (for move / sibling lookup). */
  list: Statement[];
  index: number;
  stmt: Statement;
}

function resolveSite(body: Body, addr: StmtAddr): StmtSite | null {
  return resolveSiteIn(body.statements, addr);
}

function resolveSiteIn(statements: Statement[], addr: StmtAddr): StmtSite | null {
  const path = asPath(addr);
  if (path.length === 0) return null;
  let list: Statement[] = statements;
  let stmt: Statement | undefined;
  for (let i = 0; i < path.length; i++) {
    const step = path[i]!;
    if (i > 0) {
      const sub = subList(stmt as Statement, step.list);
      if (!sub) return null;
      list = sub;
    }
    stmt = list[step.index];
    if (!stmt) return null;
  }
  return { list, index: path[path.length - 1]!.index, stmt: stmt as Statement };
}

/** The statement a flat index / nested path addresses inside a statement list —
 *  the addressing core, exposed so the expression-slot layer can resolve a slot
 *  that hangs off a statement nested in a `for` / `if let` / `match` block. */
export function statementAt(statements: readonly Statement[], addr: StmtAddr): Statement | null {
  return resolveSiteIn(statements as Statement[], addr)?.stmt ?? null;
}

/** Every nested statement list a container statement carries, keyed by the
 *  `StmtList` step a path uses to descend into it (empty for a leaf statement,
 *  and for a container whose optional block is absent). */
export function nestedStmtLists(stmt: Statement): { list: StmtList; items: Statement[] }[] {
  const out: { list: StmtList; items: Statement[] }[] = [];
  const push = (list: StmtList, items: Statement[] | undefined): void => {
    if (items && items.length > 0) out.push({ list, items });
  };
  if (stmt.$type === "ForStmt") push("body", (stmt as ForStmt).body);
  else if (stmt.$type === "IfLetStmt") {
    push("then", (stmt as IfLetStmt).thenBody);
    push("else", (stmt as IfLetStmt).elseBody);
  } else if (stmt.$type === "MatchStmt") {
    const m = stmt as MatchStmt;
    m.varArms.forEach((arm, i) => push({ arm: i }, arm.body));
    push("else", m.elseBody);
  }
  return out;
}

/** Where a new statement goes: a container statement's sub-list, or (when
 *  `at` is omitted) the addressed body's own top-level list. */
export interface StmtInsertTarget {
  at?: StmtAddr;
  list?: StmtList;
}

export function editStatement(
  source: string,
  loc: BodyLocator,
  addr: StmtAddr,
  text: string,
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const cst = body ? resolveSite(body, addr)?.stmt.$cstNode : undefined;
  if (!cst) return null;
  return ifParses(applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: text.trim() }]));
}

export function deleteStatement(source: string, loc: BodyLocator, addr: StmtAddr): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const cst = body ? resolveSite(body, addr)?.stmt.$cstNode : undefined;
  if (!cst) return null;
  // Swallow the preceding line break + indentation so no blank line is left.
  let start = cst.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  return ifParses(applyEdits(source, [{ offset: start, end: cst.end, newText: "" }]));
}

export function moveStatement(
  source: string,
  loc: BodyLocator,
  addr: StmtAddr,
  dir: -1 | 1,
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const site = body ? resolveSite(body, addr) : null;
  const a = site?.stmt.$cstNode;
  const b = site?.list[site.index + dir]?.$cstNode;
  if (!a || !b) return null;
  // Swap the two statements' source text in place (whitespace between stays).
  return ifParses(
    applyEdits(source, [
      { offset: a.offset, end: a.end, newText: b.text },
      { offset: b.offset, end: b.end, newText: a.text },
    ]),
  );
}

export function addStatement(
  source: string,
  loc: BodyLocator,
  text: string,
  into: StmtInsertTarget = {},
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  if (!body) return null;
  const stmt = text.trim();
  if (!stmt) return null;

  let list: readonly Statement[] = body.statements;
  let blockClose: number | null = null;
  let blockIndent = "";
  if (into.at !== undefined) {
    const site = resolveSite(body, into.at);
    if (!site) return null;
    const sub = subList(site.stmt, into.list);
    if (!sub) return null;
    const block = blockOf(site.stmt, into.list);
    if (!block) return null;
    list = sub;
    blockClose = block.close;
    blockIndent = lineIndent(source, block.open);
  }

  const last = list[list.length - 1]?.$cstNode;
  if (last) {
    // Append after the last statement, matching its indentation.
    const indent = lineIndent(source, last.offset);
    return ifParses(
      applyEdits(source, [{ offset: last.end, end: last.end, newText: `\n${indent}${stmt}` }]),
    );
  }
  if (blockClose !== null) return ifParses(openBlock(source, blockClose, blockIndent, stmt));
  // Empty body: insert before the owner's closing brace.
  const ownerCst = body.owner.$cstNode;
  if (!ownerCst) return null;
  return ifParses(openBlock(source, ownerCst.end - 1, lineIndent(source, ownerCst.offset), stmt));
}

/** Insert the first statement of an EMPTY block, before its closing brace at
 *  `close`.  When that brace sits on its own line the existing indentation is
 *  reused (so no stray blank line is left behind); on a one-line `{ }` the
 *  statement opens a fresh line. */
function openBlock(source: string, close: number, indent: string, stmt: string): string {
  let cut = close;
  while (cut > 0 && (source[cut - 1] === " " || source[cut - 1] === "\t")) cut--;
  const onOwnLine = cut > 0 && source[cut - 1] === "\n";
  return onOwnLine
    ? applyEdits(source, [{ offset: cut, end: close, newText: `${indent}  ${stmt}\n${indent}` }])
    : applyEdits(source, [{ offset: close, end: close, newText: `\n${indent}  ${stmt}\n${indent}` }]);
}

// ---------------------------------------------------------------------------
// Part edits — rewrite ONE token / expression of a structured statement (the
// binder of a loop, a match arm's variant, a precondition's message) instead of
// re-stringifying the statement and losing its nested block verbatim.
// ---------------------------------------------------------------------------

export type StmtPart =
  | "expr" // precondition / requires predicate, `let` value, `return` value
  | "name" // `let` name, `for` binder, `if let` binder
  | "iterable" // `for` iterable
  | "subject" // `if let` source, `match` subject
  | "message" // `precondition … message "…"`
  | { arm: number; field: "variant" | "binder" };

/** CST range of a statement part, or null when the part does not apply. */
function partRange(stmt: Statement, part: StmtPart): { offset: number; end: number } | null {
  const range = (n: AstNode | undefined): { offset: number; end: number } | null => {
    const c = n?.$cstNode;
    return c ? { offset: c.offset, end: c.end } : null;
  };
  const prop = (n: AstNode, name: string): { offset: number; end: number } | null => {
    const c = GrammarUtils.findNodeForProperty(n.$cstNode, name);
    return c ? { offset: c.offset, end: c.end } : null;
  };
  if (typeof part === "object") {
    if (stmt.$type !== "MatchStmt") return null;
    const arm = (stmt as MatchStmt).varArms[part.arm];
    if (!arm) return null;
    return part.field === "variant" ? range(arm.varType) : prop(arm, "binding");
  }
  switch (part) {
    case "expr":
      if (stmt.$type === "PreconditionStmt") return range((stmt as PreconditionStmt).expr);
      if (stmt.$type === "RequiresStmt") return range((stmt as RequiresStmt).expr);
      if (stmt.$type === "LetStmt") return range((stmt as LetStmt).expr);
      if (stmt.$type === "ReturnStmt") return range((stmt as ReturnStmt).value);
      return null;
    case "name":
      if (stmt.$type === "LetStmt") return prop(stmt, "name");
      if (stmt.$type === "ForStmt" || stmt.$type === "IfLetStmt") return prop(stmt, "var");
      return null;
    case "iterable":
      return stmt.$type === "ForStmt" ? range((stmt as ForStmt).iterable) : null;
    case "subject":
      if (stmt.$type === "IfLetStmt") return range((stmt as IfLetStmt).source);
      if (stmt.$type === "MatchStmt") return range((stmt as MatchStmt).subject);
      return null;
    default:
      return null;
  }
}

/** Rewrite one part of a statement. `message` is special: an empty `text`
 *  DROPS the clause, and a value on a statement that has none APPENDS it. */
export function editStatementPart(
  source: string,
  loc: BodyLocator,
  addr: StmtAddr,
  part: StmtPart,
  text: string,
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const stmt = body ? resolveSite(body, addr)?.stmt : undefined;
  if (!stmt) return null;

  if (part === "message") {
    if (stmt.$type !== "PreconditionStmt") return null;
    const p = stmt as PreconditionStmt;
    const exprEnd = p.expr.$cstNode?.end;
    if (exprEnd === undefined) return null;
    const existing = GrammarUtils.findNodeForProperty(p.$cstNode, "message");
    const value = text.trim();
    if (value === "") {
      // Drop the whole `message "…"` clause (nothing when there is none).
      if (!existing) return source;
      return ifParses(applyEdits(source, [{ offset: exprEnd, end: existing.end, newText: "" }]));
    }
    const quoted = JSON.stringify(value);
    return existing
      ? ifParses(applyEdits(source, [{ offset: existing.offset, end: existing.end, newText: quoted }]))
      : ifParses(
          applyEdits(source, [{ offset: exprEnd, end: exprEnd, newText: ` message ${quoted}` }]),
        );
  }

  const range = partRange(stmt, part);
  const value = text.trim();
  if (!range) {
    // An arm binder the source doesn't declare yet — append it after the
    // variant type so `Variant => …` becomes `Variant b => …`.
    if (typeof part === "object" && part.field === "binder" && stmt.$type === "MatchStmt" && value !== "") {
      const arm = (stmt as MatchStmt).varArms[part.arm];
      const at = arm?.varType.$cstNode?.end;
      if (at === undefined) return null;
      return ifParses(applyEdits(source, [{ offset: at, end: at, newText: ` ${value}` }]));
    }
    return null;
  }
  if (value === "") return null;
  return ifParses(applyEdits(source, [{ offset: range.offset, end: range.end, newText: value }]));
}

/** Append `<Variant> [binder] => { }` to a statement-form `match`. */
export function addMatchArm(
  source: string,
  loc: BodyLocator,
  addr: StmtAddr,
  variant: string,
  binder?: string,
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const stmt = body ? resolveSite(body, addr)?.stmt : undefined;
  if (!stmt || stmt.$type !== "MatchStmt") return null;
  const name = variant.trim();
  if (!name) return null;
  const m = stmt as MatchStmt;
  const braces = directBraces(m);
  const last = m.varArms[m.varArms.length - 1]?.$cstNode;
  const anchor = last?.end ?? braces[0]?.end;
  if (anchor === undefined) return null;
  const indent = last
    ? lineIndent(source, last.offset)
    : `${lineIndent(source, m.$cstNode?.offset ?? anchor)}  `;
  const head = binder?.trim() ? `${name} ${binder.trim()}` : name;
  return ifParses(
    applyEdits(source, [
      { offset: anchor, end: anchor, newText: `\n${indent}${head} => {\n${indent}}` },
    ]),
  );
}

/** Delete one arm of a statement-form `match`, comma and all. */
export function deleteMatchArm(
  source: string,
  loc: BodyLocator,
  addr: StmtAddr,
  armIndex: number,
): string | null {
  const parsed = parseDdd(source);
  if (parsed.parserErrors.length > 0) return null;
  const body = resolveBody(parsed.ast, loc);
  const stmt = body ? resolveSite(body, addr)?.stmt : undefined;
  if (!stmt || stmt.$type !== "MatchStmt") return null;
  const cst = (stmt as MatchStmt).varArms[armIndex]?.$cstNode;
  if (!cst) return null;
  let start = cst.offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;
  // Take the arm separator with it.
  let end = cst.end;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end++;
  if (source[end] === ",") end++;
  else end = cst.end;
  return ifParses(applyEdits(source, [{ offset: start, end, newText: "" }]));
}
