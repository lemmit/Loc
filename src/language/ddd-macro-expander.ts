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

import type { LangiumDocument } from "langium";
import { AstUtils, DocumentState } from "langium";
import type { LangiumSharedServices } from "langium/lsp";
import { isMarkNode, type MarkNode, _withOrigin } from "../macro-api/factories.js";
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
  isSystem,
  isUi,
  type MacroArg,
  type MacroCall,
  type Model,
  type Ui,
  type UiMember,
} from "./generated/ast.js";
import { allMacros, lookupMacro } from "./macro-registry.js";

// ---------------------------------------------------------------------------
// Side-table — capability flags per host node, populated by mark().
// Read by lowering to populate `AggregateIR.flags`.
// ---------------------------------------------------------------------------

const _flagsByHost = new WeakMap<object, CapabilityFlagBag>();

/** Flag bag stored against a host AST node (the Aggregate / Ui).
 * Keyed by flag name; value is the optional data object the macro
 * passed to `mark(name, data)`. */
export interface CapabilityFlagBag {
  readonly flags: Map<string, Record<string, unknown> | undefined>;
}

/** Lower-side hook: read capability flags for a given host AST
 * node.  Returns an empty bag if no macros have run on it. */
export function flagsFor(host: object): CapabilityFlagBag {
  let bag = _flagsByHost.get(host);
  if (!bag) {
    bag = { flags: new Map() };
    _flagsByHost.set(host, bag);
  }
  return bag;
}

/** Test/harness hook — clear all recorded flags. */
export function _resetFlagsForTests(): void {
  // WeakMap can't be cleared in place; reassign via the module-
  // private binding.  Because `_flagsByHost` is a const, we
  // instead drop entries by iterating known keys — but WeakMap
  // doesn't expose keys.  For tests, we accept that stale flags
  // are tied to garbage-collected hosts and rely on fresh AST
  // construction per test.  Keep this stub for symmetry with
  // _resetRegistryForTests.
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
// Walk + expand
// ---------------------------------------------------------------------------

function expandModel(model: Model, doc: LangiumDocument): void {
  // streamAllContents walks the AST via `$container`-respecting
  // traversal — safe from cycle-via-parent-pointer recursion.
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) expandHost(node, "aggregate", doc);
    else if (isUi(node)) expandHost(node, "ui", doc);
  }
  void isSystem; // imported for symmetry with future system-level macros
}

function expandHost(host: Aggregate | Ui, kind: "aggregate" | "ui", doc: LangiumDocument): void {
  const wc = host.withClause;
  if (!wc) return;
  for (const call of wc.calls ?? []) {
    expandOneCall(call, host, kind, doc);
  }
}

function expandOneCall(
  call: MacroCall,
  host: Aggregate | Ui,
  hostKind: "aggregate" | "ui",
  doc: LangiumDocument,
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
  const argResult = bindArgs(macro, call, doc);
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

  // Partition produced members into marks (flags) vs. real AST members.
  const realMembers: unknown[] = [];
  const flagBag = flagsFor(host);
  for (const item of produced) {
    if (isMarkNode(item)) {
      const m = item as MarkNode;
      if (flagBag.flags.has(m.name)) {
        recordDiagnostic(doc, {
          severity: "error",
          message:
            `Macro '${name}' set flag '${m.name}' which is already set on this ${hostKind}.  ` +
            `Two macros cannot both contribute the same capability flag.`,
          node: call,
          property: "name",
        });
        continue;
      }
      flagBag.flags.set(m.name, m.data);
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
    const v = coerceArg(macro.name, name, arg, ps, doc);
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
        const target = (v as any).ref?.ref;
        if (!target) {
          // Unresolved at this phase is normal — pass the textual
          // reference through; backends iterate the resolved node
          // post-link.  Macro authors that need the resolved node
          // must access it through call-time inspection (future).
          return { ok: true, value: (v as any).ref };
        }
        return { ok: true, value: target };
      }
      break;
    case "refList":
      if (v.$type === "MacroArgRefList") {
        const refs = (v as any).refs ?? [];
        const values = refs.map((r: any) => (r.ref as object) ?? r);
        return { ok: true, value: values };
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

function listMacroNames(): string {
  const names = allMacros().map((m) => m.name);
  return names.length ? names.join(", ") : "(none registered)";
}
