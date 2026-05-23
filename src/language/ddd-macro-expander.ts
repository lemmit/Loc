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
import { isContextFilter, isContextStamp, _withOrigin } from "../macro-api/factories.js";
import type {
  MacroDefinition,
  OriginToken,
  ParamSpec,
  ParamType,
} from "../macro-api/define.js";
import { loadStdlibMacros } from "../stdlib/index.js";
import {
  type Aggregate,
  type AggregateMember,
  isAggregate,
  isBoundedContext,
  isModule,
  isSystem,
  isUi,
  isView,
  isWorkflow,
  type MacroArg,
  type MacroCall,
  type Model,
  type Ui,
  type UiMember,
} from "./generated/ast.js";
import type { NamedDeclKind } from "../macro-api/define.js";
import { allMacros, lookupMacro } from "./macro-registry.js";

// ---------------------------------------------------------------------------
// Side-table — capabilities per host node, populated by
// contextFilter() / contextStamp() factories.  Lowered into
// AggregateIR.contextFilters / .contextStamps by lower.ts using the
// aggregate-scoped Env, after the linker resolves references.
// ---------------------------------------------------------------------------

const _capabilitiesByHost = new WeakMap<object, CapabilityBag>();

/** Per-host capability bag.  Stores raw Expression AST so the IR
 * layer can lower with a proper Env (lambdas, this-prop resolution,
 * currentUser binding) instead of the expander building a synthetic
 * one before the linker has run. */
export interface CapabilityBag {
  readonly filters: import("./generated/ast.js").Expression[];
  readonly stamps: Array<{
    event: "create" | "update";
    assignments: Array<{
      field: string;
      value: import("./generated/ast.js").Expression;
    }>;
  }>;
}

/** Lower-side hook: read capability contributions for a given host
 * AST node.  Returns an empty bag if no macros have run on it. */
export function capabilitiesFor(host: object): CapabilityBag {
  let bag = _capabilitiesByHost.get(host);
  if (!bag) {
    bag = { filters: [], stamps: [] };
    _capabilitiesByHost.set(host, bag);
  }
  return bag;
}

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
  loadStdlibMacros();
  shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.IndexedContent, async (doc) => {
    const root = doc.parseResult.value as Model | undefined;
    if (!root) return;
    expandModel(root, doc);
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
  Module: Map<string, AstNode>;
  BoundedContext: Map<string, AstNode>;
  Workflow: Map<string, AstNode>;
  View: Map<string, AstNode>;
  ValueObject: Map<string, AstNode>;
  EnumDecl: Map<string, AstNode>;
}

function buildInventory(model: Model): Inventory {
  const inv: Inventory = {
    Aggregate: new Map(),
    Module: new Map(),
    BoundedContext: new Map(),
    Workflow: new Map(),
    View: new Map(),
    ValueObject: new Map(),
    EnumDecl: new Map(),
  };
  for (const node of AstUtils.streamAllContents(model)) {
    const named = node as AstNode & { name?: string };
    if (typeof named.name !== "string") continue;
    if (isAggregate(node)) inv.Aggregate.set(named.name, node);
    else if (isModule(node)) inv.Module.set(named.name, node);
    else if (isBoundedContext(node)) inv.BoundedContext.set(named.name, node);
    else if (isWorkflow(node)) inv.Workflow.set(named.name, node);
    else if (isView(node)) inv.View.set(named.name, node);
    else if (node.$type === "ValueObject") inv.ValueObject.set(named.name, node);
    else if (node.$type === "EnumDecl") inv.EnumDecl.set(named.name, node);
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Walk + expand
// ---------------------------------------------------------------------------

function expandModel(model: Model, doc: LangiumDocument): void {
  // Inventory shared across all macro expansions in this pass —
  // O(N) AST walk once, instead of once per ref-list arg.
  const inv = buildInventory(model);
  // streamAllContents walks the AST via `$container`-respecting
  // traversal — safe from cycle-via-parent-pointer recursion.
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) expandHost(node, "aggregate", doc, inv);
    else if (isUi(node)) expandHost(node, "ui", doc, inv);
  }
  void isSystem; // imported for symmetry with future system-level macros
}

function expandHost(
  host: Aggregate | Ui,
  kind: "aggregate" | "ui",
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
  host: Aggregate | Ui,
  hostKind: "aggregate" | "ui",
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
      message:
        `Macro '${name}' targets '${macro.target}' but was invoked on a '${hostKind}'.`,
      node: call,
      property: "name",
    });
    return;
  }
  const argResult = bindArgs(macro, call, doc, inv);
  if (!argResult.ok) return;
  const origin: OriginToken = {
    _kind: "macro-origin",
    macroName: name,
    callNode: call,
  };
  let produced: ReadonlyArray<unknown>;
  try {
    produced = _withOrigin(origin, () =>
      macro.expand({
        target: host as any,
        args: argResult.values,
        origin,
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

  // Partition the macro's return value into:
  //   - capability contributions (contextFilter / contextStamp) →
  //     stashed on the per-host CapabilityBag for the lowerer to
  //     pull through lowerExpr with a proper Env
  //   - regular AST members → spliced into the host's `members[]`
  // The split is by $type discriminator, set by each factory.
  const realMembers: unknown[] = [];
  const capBag = capabilitiesFor(host);
  for (const item of produced) {
    if (isContextFilter(item)) {
      capBag.filters.push(item.predicate);
    } else if (isContextStamp(item)) {
      if (item.onCreate?.length) {
        capBag.stamps.push({
          event: "create",
          assignments: item.onCreate.map((a) => ({ field: a.field, value: a.value })),
        });
      }
      if (item.onUpdate?.length) {
        capBag.stamps.push({
          event: "update",
          assignments: item.onUpdate.map((a) => ({ field: a.field, value: a.value })),
        });
      }
    } else {
      realMembers.push(item);
    }
  }

  spliceMembers(host, hostKind, realMembers, call, doc);
}

function spliceMembers(
  host: Aggregate | Ui,
  hostKind: "aggregate" | "ui",
  members: unknown[],
  call: MacroCall,
  doc: LangiumDocument,
): void {
  if (members.length === 0) return;
  const targetList = (host as unknown as { members: unknown[] }).members;
  const existingNames = new Set<string>();
  for (const m of targetList) {
    const n = (m as any).name;
    if (typeof n === "string") existingNames.add(n);
  }
  for (const m of members) {
    if (!m || typeof m !== "object") {
      recordDiagnostic(doc, {
        severity: "error",
        message: `Macro returned a non-AST value (${typeof m}); expected an AST member or mark.`,
        node: call,
      });
      continue;
    }
    const name = (m as any).name;
    // Override-by-name: if the user explicitly declared a member
    // with the same name, the explicit declaration wins and the
    // macro's contribution is silently skipped.  Required for
    // scaffold-style overrides; harmless for trait macros (they
    // shouldn't add duplicates in the first place).
    if (typeof name === "string" && existingNames.has(name)) continue;
    // Wire $container and append.
    (m as any).$container = host;
    (m as any).$containerProperty = "members";
    (m as any).$containerIndex = targetList.length;
    targetList.push(m);
    if (typeof name === "string") existingNames.add(name);
    void hostKind; // reserved for future per-kind validation
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

function bindArgs(
  macro: MacroDefinition,
  call: MacroCall,
  doc: LangiumDocument,
  inv: Inventory,
): BindResult | BindFailure {
  const spec: ParamSpec = macro.params ?? {};
  const provided = new Map<string, MacroArg>();
  for (const a of call.args ?? []) {
    if (!a.name) continue;
    if (provided.has(a.name)) {
      recordDiagnostic(doc, {
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
      recordDiagnostic(doc, {
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
    const v = coerceArg(macro.name, name, arg, ps, doc, inv);
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
      recordDiagnostic(doc, {
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
  doc: LangiumDocument,
  inv: Inventory,
): { ok: true; value: unknown } | { ok: false } {
  const v = arg.value;
  switch (spec.kind) {
    case "string":
      if (v.$type === "MacroArgString") return { ok: true, value: (v as any).string };
      break;
    case "bool":
      if (v.$type === "MacroArgBool") return { ok: true, value: (v as any).bool === "true" };
      break;
    case "int":
      if (v.$type === "MacroArgInt") return { ok: true, value: Number((v as any).int) };
      break;
    case "ref":
      if (v.$type === "MacroArgRef") {
        // After the grammar change, MacroArgRef.ref is a plain
        // string (not a Langium Reference) — the expander does
        // its own lookup against the per-document inventory.
        const refText = (v as any).ref as string | undefined;
        if (!refText) return { ok: false };
        const resolved = resolveRef(inv, spec.of, refText);
        if (!resolved) {
          recordDiagnostic(doc, {
            severity: "error",
            message:
              `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
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
        const refs = ((v as any).refs ?? []) as string[];
        const resolved: AstNode[] = [];
        let anyBad = false;
        for (const refText of refs) {
          if (!refText) continue;
          const node = resolveRef(inv, spec.of, refText);
          if (!node) {
            recordDiagnostic(doc, {
              severity: "error",
              message:
                `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
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
  recordDiagnostic(doc, {
    severity: "error",
    message: `Argument '${argName}' to macro '${macroName}' expected kind '${spec.kind}'.`,
    node: arg,
    property: "value",
  });
  return { ok: false };
}

function resolveRef(inv: Inventory, kind: NamedDeclKind, name: string): AstNode | undefined {
  return inv[kind].get(name);
}

function listMacroNames(): string {
  const names = allMacros().map((m) => m.name);
  return names.length ? names.join(", ") : "(none registered)";
}
