// Macro expander.
//
// Runs as a `DocumentState.IndexedContent` listener on the shared
// `DocumentBuilder` — same hook point that scaffold expansion uses
// today.  For every `with X(...)` clause attached to an aggregate
// or ui block, we:
//
//   1. Look up `X` in the macro registry.
//   2. Parse and type-check the call's arguments against the
//      macro's declared `params`, filling defaults.
//   3. Bind a fresh OriginToken keyed to this MacroCall's CST node.
//   4. Invoke `expand()` inside `_withOrigin(...)` so factory-
//      produced nodes auto-tag.
//   5. Splice the returned members into the host's members[] array
//      (wiring `$container`/`$containerProperty`/`$containerIndex`).
//   6. Collect `mark(...)` results out-of-band on a side-table the
//      lowerer reads to populate `AggregateIR.flags`.
//
// Validation diagnostics (unknown macro, bad arg type, target-kind
// mismatch) emit to the document's parseResult diagnostics so the
// validator surfaces them with the rest.
//
// Phase ordering after we mutate (same as scaffold expander):
//   IndexedContent (=2) ← we run here, after it
//   ComputedScopes (=3) — local scope walks the (expanded) members
//   Linked        (=4) — cross-references inside synthesised
//                          members resolve through standard machinery
//   Validated     (=6)

import type { AstNode, LangiumDocument } from "langium";
import { AstUtils, DocumentState } from "langium";
import type { LangiumSharedServices } from "langium/lsp";
import {
  type Aggregate,
  isAggregate,
  isBoundedContext,
  isSubdomain,
  isSystem,
  isUi,
  isView,
  isWorkflow,
  type MacroArg,
  type MacroCall,
  type Model,
  type Ui,
} from "../language/generated/ast.js";
import { readArgBool, readArgInt, readArgRef, readArgRefs, readArgString } from "./api/_read.js";
import type {
  MacroDefinition,
  NamedDeclKind,
  OriginToken,
  ParamSpec,
  ParamType,
} from "./api/define.js";
import { _withOrigin } from "./api/factories.js";
import { allMacros, lookupMacro } from "./registry.js";

// Side-table mechanism removed: capabilities are now first-class
// AST members (FilterDecl / StampDecl / ImplementsDecl) spliced into
// the host's `members[]` array, indistinguishable from user-written
// ones.  Lowering reads structurally — see `lowerAggregate` and
// `lowerContext` in `src/ir/lower/lower.ts`.

// ---------------------------------------------------------------------------
// Diagnostic accumulation — surfaced through document parseResult.
// ---------------------------------------------------------------------------

interface ExpansionDiagnostic {
  severity: "error" | "warning";
  message: string;
  node: object;
  property?: string;
}

const _diagnosticsByDoc = new WeakMap<LangiumDocument, ExpansionDiagnostic[]>();

/** Validator-side hook: drain accumulated macro expansion
 * diagnostics for the given document and emit them via
 * ValidationAcceptor.  See `ddd-validator.ts:checkMacros`. */
export function drainMacroDiagnostics(doc: LangiumDocument): ExpansionDiagnostic[] {
  const out = _diagnosticsByDoc.get(doc) ?? [];
  _diagnosticsByDoc.delete(doc);
  return out;
}

function recordDiagnostic(doc: LangiumDocument, d: ExpansionDiagnostic): void {
  let list = _diagnosticsByDoc.get(doc);
  if (!list) {
    list = [];
    _diagnosticsByDoc.set(doc, list);
  }
  list.push(d);
}

// ---------------------------------------------------------------------------
// Service registration
// ---------------------------------------------------------------------------

export function registerMacroExpander(shared: LangiumSharedServices): void {
  // Ensure stdlib is registered before the first document is built.
  shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.IndexedContent, async (doc) => {
    const root = doc.parseResult.value as Model | undefined;
    if (!root) return;
    expandModel(root, doc, shared);
  });
}

// ---------------------------------------------------------------------------
// Per-document named-declaration inventory.
//
// Macro args of kind `ref` / `refList` reference declarations by
// name (`with scaffold(aggregates: [Order, Customer])`).  By the
// IndexedContent phase — where the expander runs — Langium's
// linker hasn't resolved cross-references yet, so `ref.ref` is
// undefined.  We do our own lookup against this inventory built
// from a single AST walk.
//
// Built lazily per document and per expansion pass (not cached
// across builds) so that re-expansion after a user edit sees the
// fresh AST.

interface Inventory {
  Aggregate: Map<string, AstNode>;
  Subdomain: Map<string, AstNode>;
  BoundedContext: Map<string, AstNode>;
  Workflow: Map<string, AstNode>;
  View: Map<string, AstNode>;
  ValueObject: Map<string, AstNode>;
  EnumDecl: Map<string, AstNode>;
}

function buildInventory(model: Model, shared?: LangiumSharedServices): Inventory {
  const inv: Inventory = {
    Aggregate: new Map(),
    Subdomain: new Map(),
    BoundedContext: new Map(),
    Workflow: new Map(),
    View: new Map(),
    ValueObject: new Map(),
    EnumDecl: new Map(),
  };
  const scan = (root: Model): void => {
    for (const node of AstUtils.streamAllContents(root)) {
      const named = node as AstNode & { name?: string };
      if (typeof named.name !== "string") continue;
      if (isAggregate(node)) inv.Aggregate.set(named.name, node);
      else if (isSubdomain(node)) inv.Subdomain.set(named.name, node);
      else if (isBoundedContext(node)) inv.BoundedContext.set(named.name, node);
      else if (isWorkflow(node)) inv.Workflow.set(named.name, node);
      else if (isView(node)) inv.View.set(named.name, node);
      else if (node.$type === "ValueObject") inv.ValueObject.set(named.name, node);
      else if (node.$type === "EnumDecl") inv.EnumDecl.set(named.name, node);
    }
  };
  // Sibling documents first, then the local model — so a local
  // declaration wins on a name collision.  Scanning the whole import
  // graph lets a macro ref-list argument (e.g. `scaffold(subdomains:
  // [Sales])`) resolve a `subdomain` declared in another file, which the
  // implicit-system composition then folds into the one project system.
  if (shared) {
    for (const doc of shared.workspace.LangiumDocuments.all) {
      const root = doc.parseResult?.value as Model | undefined;
      if (root && root !== model) scan(root);
    }
  }
  scan(model);
  return inv;
}

// ---------------------------------------------------------------------------
// Walk + expand
// ---------------------------------------------------------------------------

function expandModel(model: Model, doc: LangiumDocument, shared?: LangiumSharedServices): void {
  // Inventory shared across all macro expansions in this pass —
  // O(N) AST walk once, instead of once per ref-list arg.  Workspace-aware
  // so a macro ref-list can name a declaration in a sibling file.
  const inv = buildInventory(model, shared);
  // streamAllContents walks the AST via `$container`-respecting
  // traversal — safe from cycle-via-parent-pointer recursion.
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) expandHost(node, "aggregate", doc, inv);
    else if (isUi(node)) expandHost(node, "ui", doc, inv);
    else if (isBoundedContext(node)) expandHost(node, "context", doc, inv);
  }
  void isSystem; // imported for symmetry with future system-level macros
}

function expandHost(
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext,
  kind: "aggregate" | "ui" | "context",
  doc: LangiumDocument,
  inv: Inventory,
): void {
  const wc = host.withClause;
  if (!wc) return;
  for (const call of wc.calls ?? []) {
    expandOneCall(call, host, kind, doc, inv);
  }
}

function expandOneCall(
  call: MacroCall,
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext,
  hostKind: "aggregate" | "ui" | "context",
  doc: LangiumDocument,
  inv: Inventory,
): void {
  const name = call.name;
  if (!name) return;
  const macro = lookupMacro(name);
  if (!macro) {
    recordDiagnostic(doc, {
      severity: "error",
      message: `Unknown macro '${name}'.  Available: ${listMacroNames()}.`,
      node: call,
      property: "name",
    });
    return;
  }
  if (macro.target !== hostKind) {
    recordDiagnostic(doc, {
      severity: "error",
      message: `Macro '${name}' targets '${macro.target}' but was invoked on a '${hostKind}'.`,
      node: call,
      property: "name",
    });
    return;
  }
  const argResult = bindArgs(macro, call, inv, (d) => recordDiagnostic(doc, d));
  if (!argResult.ok) return;
  const origin: OriginToken = {
    _kind: "macro-origin",
    macroName: name,
    callNode: call,
  };
  // `invokeMacro` lets a context-level macro programmatically run
  // an aggregate-level macro against a child aggregate.  Returned
  // AST nodes are tagged with $destination so spliceMembers below
  // routes them into the right host.  Inside-out invocation (e.g.
  // aggregate calling a context macro on its parent) is rejected
  // at splice time by the descendant check.
  const invokeMacro = (
    childName: string,
    opts: { target: object; args?: Record<string, unknown> },
  ): unknown[] => {
    const child = lookupMacro(childName);
    if (!child) {
      recordDiagnostic(doc, {
        severity: "error",
        message:
          `Macro '${name}' invoked unknown macro '${childName}'.  ` +
          `Available: ${listMacroNames()}.`,
        node: call,
        property: "name",
      });
      return [];
    }
    let childProduced: ReadonlyArray<unknown> = [];
    try {
      childProduced = _withOrigin(origin, () =>
        child.expand({
          // `child` is a `MacroDefinition` whose T is erased to the
          // upper bound here; `expand` therefore expects the union
          // `TargetNodeOf[MacroTarget]` (Aggregate | Ui | BoundedContext).
          // The caller has already chosen the right concrete `target`
          // for `child.target`, but the type system can't see that —
          // this cast bridges the variance.
          target: opts.target as Aggregate,
          args: opts.args ?? {},
          origin,
          invokeMacro,
        }),
      );
    } catch (err) {
      recordDiagnostic(doc, {
        severity: "error",
        message: `Macro '${childName}' (invoked from '${name}') threw: ${(err as Error).message}`,
        node: call,
        property: "name",
      });
      return [];
    }
    // Flatten + tag each node with its intended destination (the
    // child macro's target), so spliceMembers below routes them
    // into that target's members[] rather than the outer host.
    const flatChild: unknown[] = [];
    for (const item of childProduced) {
      if (Array.isArray(item)) {
        for (const inner of item) flatChild.push(tagDestination(inner, opts.target));
      } else {
        flatChild.push(tagDestination(item, opts.target));
      }
    }
    return flatChild;
  };
  let produced: ReadonlyArray<unknown>;
  try {
    produced = _withOrigin(origin, () =>
      macro.expand({
        // `macro` is a `MacroDefinition` whose T is erased to the
        // upper bound here; `expand` therefore expects the union
        // `TargetNodeOf[MacroTarget]` (Aggregate | Ui | BoundedContext).
        // `host` is the same union; the runtime check at the top of
        // this function (`macro.target !== hostKind`) guarantees the
        // pairing, but the type system can't see that — this cast
        // bridges the variance.
        target: host as Aggregate,
        args: argResult.values,
        origin,
        invokeMacro,
      }),
    );
  } catch (err) {
    recordDiagnostic(doc, {
      severity: "error",
      message: `Macro '${name}' threw during expansion: ${(err as Error).message}`,
      node: call,
      property: "name",
    });
    return;
  }

  // Every item returned from `expand()` is now a regular AST
  // member — including capability nodes (FilterDecl / StampDecl /
  // ImplementsDecl), which the factories produce as real members
  // rather than tagged pseudo-members.  Flatten one level so
  // helper factories that return arrays (e.g. `contextStamp` emits
  // one node per event, returned as a tuple) can be spread or
  // returned directly.
  const flat: unknown[] = [];
  for (const item of produced) {
    if (Array.isArray(item)) flat.push(...item);
    else flat.push(item);
  }
  spliceMembers(host, hostKind, flat, call, doc);
}

/** Hidden property used by `invokeMacro` to redirect a returned
 * node's splice destination from "the calling macro's host" to "the
 * node that the called macro was applied to."  Read by
 * `spliceMembers` below; never observed by macro authors. */
const DEST_PROP = "$destination" as const;

/** Tag a node so spliceMembers routes it into `dest.members` rather
 * than the calling macro's host.  Used internally by `invokeMacro`. */
function tagDestination(node: unknown, dest: object): unknown {
  if (node && typeof node === "object") {
    (node as Record<string, unknown>)[DEST_PROP] = dest;
  }
  return node;
}

/** True iff `candidate` is `host` or a transitive descendant of
 * `host` in the AST.  Used to validate that `invokeMacro`'s target
 * sits inside the calling macro's host — context macro CAN invoke
 * against a child aggregate; aggregate macro CANNOT invoke against
 * its parent context (would be "calling external from internal,"
 * which the design disallows). */
function isHostOrDescendant(host: object, candidate: object): boolean {
  let cur: unknown = candidate;
  while (cur && typeof cur === "object") {
    if (cur === host) return true;
    cur = (cur as Record<string, unknown>).$container;
  }
  return false;
}

function spliceMembers(
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext,
  hostKind: "aggregate" | "ui" | "context",
  members: unknown[],
  call: MacroCall,
  doc: LangiumDocument,
): void {
  if (members.length === 0) return;
  // Group nodes by their destination — most go to `host`; nodes
  // tagged via `invokeMacro` go to their explicit destination.
  const byDest = new Map<object, unknown[]>();
  for (const m of members) {
    if (!m || typeof m !== "object") {
      recordDiagnostic(doc, {
        severity: "error",
        message: `Macro returned a non-AST value (${typeof m}); expected an AST member or capability node.`,
        node: call,
      });
      continue;
    }
    const tagged = (m as Record<string, unknown>)[DEST_PROP] as object | undefined;
    const dest = tagged ?? host;
    // Inside-out guard: the destination must be the host OR a
    // descendant of the host in the AST.  Catches accidental
    // attempts to splice into a sibling / ancestor / unrelated node.
    if (!isHostOrDescendant(host, dest)) {
      recordDiagnostic(doc, {
        severity: "error",
        message:
          "Macro emitted a node targeting a destination outside the host's subtree.  " +
          "Macros may only modify their host or its descendants (e.g. a context-level macro " +
          "may invoke an aggregate-level macro against an aggregate inside the context).",
        node: call,
        property: "name",
      });
      continue;
    }
    // Strip the tag before splicing — the destination is captured.
    delete (m as Record<string, unknown>)[DEST_PROP];
    let bucket = byDest.get(dest);
    if (!bucket) {
      bucket = [];
      byDest.set(dest, bucket);
    }
    bucket.push(m);
  }
  for (const [dest, bucket] of byDest) {
    spliceIntoTarget(dest, bucket);
  }
  void hostKind; // reserved for future per-kind validation
}

/** Append `members` into `target.members[]`, wiring `$container`
 * triples and honouring override-by-name (an explicit member with
 * the same name as one of the synthesised members wins; the
 * synthesised member is silently dropped). */
function spliceIntoTarget(target: object, members: unknown[]): void {
  const targetList = (target as { members: unknown[] }).members;
  if (!Array.isArray(targetList)) return;

  // Collect existing member names, descending into `area` blocks so an
  // explicit page (top-level OR inside an area) suppresses a synthesised page
  // of the same name even when the synthesised one is nested in an area.
  const existingNames = new Set<string>();
  const collectNames = (list: unknown[]): void => {
    for (const m of list) {
      const n = (m as { name?: unknown }).name;
      if (typeof n === "string") existingNames.add(n);
      if ((m as { $type?: unknown }).$type === "Area") {
        collectNames(((m as { members?: unknown[] }).members ?? []) as unknown[]);
      }
    }
  };
  collectNames(targetList);

  // Drop the members of a synthesised `area` whose name is already declared
  // (override-by-name reaches into areas), re-wiring kept members' containers.
  // Returns true if the area still has ≥1 member after filtering.
  const pruneArea = (areaNode: { members?: unknown[] }): boolean => {
    const kept: unknown[] = [];
    for (const inner of areaNode.members ?? []) {
      const innerName = (inner as { name?: unknown }).name;
      if ((inner as { $type?: unknown }).$type === "Area") {
        if (pruneArea(inner as { members?: unknown[] })) kept.push(inner);
      } else if (typeof innerName === "string" && existingNames.has(innerName)) {
        // overridden by an explicit declaration — drop it
      } else {
        kept.push(inner);
      }
    }
    areaNode.members = kept;
    kept.forEach((inner, i) => {
      (inner as Record<string, unknown>).$container = areaNode;
      (inner as Record<string, unknown>).$containerProperty = "members";
      (inner as Record<string, unknown>).$containerIndex = i;
    });
    return kept.length > 0;
  };

  for (const m of members) {
    const name = (m as { name?: unknown }).name;
    const isArea = (m as { $type?: unknown }).$type === "Area";
    if (isArea) {
      // Dedup: an area with the same name is already present (e.g. the same
      // aggregate listed twice in one scaffold call) — drop the duplicate.
      if (typeof name === "string" && existingNames.has(name)) continue;
      if (!pruneArea(m as { members?: unknown[] })) continue; // whole area overridden
    } else if (typeof name === "string" && existingNames.has(name)) {
      continue;
    }
    (m as Record<string, unknown>).$container = target;
    (m as Record<string, unknown>).$containerProperty = "members";
    (m as Record<string, unknown>).$containerIndex = targetList.length;
    targetList.push(m);
    if (typeof name === "string") existingNames.add(name);
    if (isArea) collectNames(((m as { members?: unknown[] }).members ?? []) as unknown[]);
  }
}

// ---------------------------------------------------------------------------
// Argument binding
// ---------------------------------------------------------------------------

interface BindResult {
  ok: true;
  values: Record<string, unknown>;
}
interface BindFailure {
  ok: false;
}

type DiagnosticRecorder = (d: ExpansionDiagnostic) => void;

function bindArgs(
  macro: MacroDefinition,
  call: MacroCall,
  inv: Inventory,
  record: DiagnosticRecorder,
): BindResult | BindFailure {
  const spec: ParamSpec = macro.params ?? {};
  const provided = new Map<string, MacroArg>();
  for (const a of call.args ?? []) {
    if (!a.name) continue;
    if (provided.has(a.name)) {
      record({
        severity: "error",
        message: `Duplicate argument '${a.name}' in call to macro '${macro.name}'.`,
        node: a,
        property: "name",
      });
      return { ok: false };
    }
    provided.set(a.name, a);
  }

  const out: Record<string, unknown> = {};
  let failed = false;

  // Check provided args against the spec.
  for (const [name, arg] of provided) {
    const ps = spec[name];
    if (!ps) {
      record({
        severity: "error",
        message:
          `Unknown argument '${name}' for macro '${macro.name}'.  ` +
          `Declared parameters: ${Object.keys(spec).join(", ") || "(none)"}.`,
        node: arg,
        property: "name",
      });
      failed = true;
      continue;
    }
    const v = coerceArg(macro.name, name, arg, ps, inv, record);
    if (v.ok) out[name] = v.value;
    else failed = true;
  }

  // Fill defaults / detect missing required args.
  for (const [name, ps] of Object.entries(spec)) {
    if (name in out) continue;
    if ("default" in ps && ps.default !== undefined) {
      out[name] = ps.default;
    } else if (ps.kind === "refList") {
      out[name] = [];
    } else if (ps.kind === "ref" && ps.optional) {
      out[name] = undefined;
    } else {
      record({
        severity: "error",
        message: `Macro '${macro.name}' requires argument '${name}' (kind=${ps.kind}).`,
        node: call,
      });
      failed = true;
    }
  }

  return failed ? { ok: false } : { ok: true, values: out };
}

function coerceArg(
  macroName: string,
  argName: string,
  arg: MacroArg,
  spec: ParamType,
  inv: Inventory,
  record: DiagnosticRecorder,
): { ok: true; value: unknown } | { ok: false } {
  const v = arg.value;
  switch (spec.kind) {
    case "string":
      if (v.$type === "MacroArgString") return { ok: true, value: readArgString(v)! };
      break;
    case "bool":
      if (v.$type === "MacroArgBool") return { ok: true, value: readArgBool(v)! };
      break;
    case "int":
      if (v.$type === "MacroArgInt") return { ok: true, value: readArgInt(v)! };
      break;
    case "ref":
      if (v.$type === "MacroArgRef") {
        // After the grammar change, MacroArgRef.ref is a plain
        // string (not a Langium Reference) — the expander does
        // its own lookup against the per-document inventory.
        const refText = readArgRef(v);
        if (!refText) return { ok: false };
        const resolved = resolveRef(inv, spec.of, refText);
        if (!resolved) {
          record({
            severity: "error",
            message: `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
            node: arg,
            property: "value",
          });
          return { ok: false };
        }
        return { ok: true, value: resolved };
      }
      break;
    case "refList":
      if (v.$type === "MacroArgRefList") {
        const refs = readArgRefs(v);
        const resolved: AstNode[] = [];
        let anyBad = false;
        for (const refText of refs) {
          if (!refText) continue;
          const node = resolveRef(inv, spec.of, refText);
          if (!node) {
            record({
              severity: "error",
              message: `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
              node: arg,
              property: "value",
            });
            anyBad = true;
            continue;
          }
          resolved.push(node);
        }
        if (anyBad) return { ok: false };
        return { ok: true, value: resolved };
      }
      break;
  }
  record({
    severity: "error",
    message: `Argument '${argName}' to macro '${macroName}' expected kind '${spec.kind}'.`,
    node: arg,
    property: "value",
  });
  return { ok: false };
}

/** Resolve a macro call's arguments against the document model the
 * way the runtime expander does, but without recording any
 * diagnostics.  Returns the bound `args` record on success, or
 * `undefined` if the call's args don't bind (unknown name, type
 * mismatch, missing required, unresolvable ref).  Used by the
 * unfold code action so it expands with the user's actual args
 * rather than empty defaults. */
export function resolveMacroArgs(
  macro: MacroDefinition,
  call: MacroCall,
  model: Model,
): Record<string, unknown> | undefined {
  const inv = buildInventory(model);
  const result = bindArgs(macro, call, inv, () => {});
  return result.ok ? result.values : undefined;
}

function resolveRef(inv: Inventory, kind: NamedDeclKind, name: string): AstNode | undefined {
  return inv[kind].get(name);
}

function listMacroNames(): string {
  const names = allMacros().map((m) => m.name);
  return names.length ? names.join(", ") : "(none registered)";
}
