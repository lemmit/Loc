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
  type Api,
  type Capability,
  isAggregate,
  isApi,
  isBoundedContext,
  isCapability,
  isCriterion,
  isImplementsDecl,
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
import { CAPABILITIES_TAG, FILTER_ORIGIN_TAG } from "../util/capability-tag.js";
import { readArgBool, readArgInt, readArgRef, readArgRefs, readArgString } from "./api/_read.js";
import type {
  MacroDefinition,
  NamedDeclKind,
  OriginToken,
  ParamSpec,
  ParamType,
} from "./api/define.js";
import { _withOrigin } from "./api/factories.js";
import { builtinCapabilities } from "./prelude.js";
import { allMacros, lookupMacro } from "./registry.js";

// The deep-clone reference rebuilder `copyAstNode` expects — the
// language Linker's `buildReference`.  A capability's members are cloned
// once per implementing aggregate (the same AST node can't live under N
// parents), and each cloned cross-reference (e.g. a `createdBy: User`
// type ref) is rebuilt here so the Linked phase resolves it normally.
type BuildRef = Parameters<typeof AstUtils.copyAstNode>[1];

// Capability members are cloned with PLAIN `{ $refText }` references (the shape
// the macro factories' `makeRef` produces), NOT the Linker's `buildReference`.
// A plain reference resolves leniently — lowering reads `$refText` directly and
// the linker never surfaces a "could not resolve" diagnostic — matching the
// field/filter/stamp macros these capabilities replace.  A linker-built
// reference would instead report unresolved targets the macro silently tolerated
// (e.g. an `auditable` `createdBy: User id` in a model with no `User` aggregate).
const buildCapabilityRef: BuildRef = (_node, _property, _refNode, refText) =>
  ({ $refText: refText }) as never;

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
  /** Reusable predicate specifications (`criterion X(...) of T = …`) keyed by
   * name — the `of:` target of `scaffoldPaged` / `scaffoldPagedApi`. */
  Criterion: Map<string, AstNode>;
  /** Typed capability declarations (typed-capabilities.md) keyed by name.
   * A `with <cap>` clause resolves against this when no macro matches. */
  Capability: Map<string, Capability>;
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
    Criterion: new Map(),
    Capability: new Map(),
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
      else if (isCriterion(node)) inv.Criterion.set(named.name, node);
      else if (isCapability(node)) inv.Capability.set(named.name, node);
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
  // Merge the built-in capability prelude into the inventory — a user-declared
  // capability of the same name already populated `inv` and wins (default, not
  // override).  Cheap and side-effect-free, so unconditional.
  for (const [name, cap] of builtinCapabilities()) {
    if (!inv.Capability.has(name)) inv.Capability.set(name, cap);
  }
  void shared;
  const buildRef = buildCapabilityRef;
  // streamAllContents walks the AST via `$container`-respecting
  // traversal — safe from cycle-via-parent-pointer recursion.
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) expandHost(node, "aggregate", doc, inv, buildRef);
    else if (isUi(node)) expandHost(node, "ui", doc, inv, buildRef);
    else if (isBoundedContext(node)) expandHost(node, "context", doc, inv, buildRef);
    else if (isApi(node)) expandHost(node, "api", doc, inv, buildRef);
  }
  void isSystem; // imported for symmetry with future system-level macros
}

function expandHost(
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext | Api,
  kind: "aggregate" | "ui" | "context" | "api",
  doc: LangiumDocument,
  inv: Inventory,
  buildRef: BuildRef,
): void {
  const wc = host.withClause;
  if (wc) {
    for (const call of wc.calls ?? []) {
      expandOneCall(call, host, kind, doc, inv, buildRef);
    }
  }
  // Typed `implements <Cap>` — a capability application, synonym of `with <Cap>`
  // (typed-capabilities.md).  The legacy `implements "string"` group-opt-in form
  // (`ImplementsDecl.name`) is handled in lowering, not here.  Snapshot the
  // member list because aggregate-scope expansion splices into it.  Only the
  // aggregate / context hosts carry `implements` members (an api / ui does not).
  if (kind === "aggregate" || kind === "context") {
    const members = [...((host as { members?: AstNode[] }).members ?? [])];
    for (const m of members) {
      if (!isImplementsDecl(m) || !m.cap) continue;
      const capDecl = inv.Capability.get(m.cap);
      if (capDecl) {
        expandCapability(capDecl, host, kind, m, doc, buildRef);
      } else {
        recordDiagnostic(doc, {
          severity: "error",
          message: `Unknown capability '${m.cap}' in 'implements'.`,
          node: m,
          property: "cap",
        });
      }
    }
  }
  // Versioning is default-on infrastructure (expressible-builtins §1, M-T3.4):
  // every aggregate is optimistically versioned by default, exactly the way it
  // carries a system `id` — so a lost-update bug cannot be introduced by
  // *forgetting* to opt in.  Applied here, AFTER any explicit `with versioned`
  // / context-level application, so it stays idempotent (the `versioned` tag is
  // already present → skip).  Runs last so a subtype's auto-`version` and its
  // base's inherited `version` dedupe by name in `mergedFieldsFor`.  This is a
  // per-aggregate splice reached during the walk — a context-level contract
  // macro (`scaffoldHandlers`) that runs BEFORE the aggregate is visited will
  // not see `version` in members, so `apiReadFields` re-derives it explicitly
  // for the read contract (the same default-on rule, keyed on `persistedAs`).
  if (kind === "aggregate") applyDefaultVersioning(host as Aggregate, doc, inv, buildRef);
}

/** Make an aggregate optimistically versioned by default (M-T3.4).  Splices the
 * built-in `versioned` capability (`version: int token = 1`) unless the
 * aggregate is already versioned or is event-sourced.
 *
 * Skips:
 *   - **event-sourced** aggregates (`persistedAs(eventLog)`) — the append-only
 *     `(stream_id, version)` stream IS their optimistic-concurrency control, so
 *     a redundant state-table `version` column would be wrong (there is no
 *     state table to carry it).
 *   - aggregates that **already** carry `versioned` (explicit `with versioned`
 *     or a context-level application already ran) — the `CAPABILITIES_TAG`
 *     records it, so re-applying would splice a second `version` field. */
function applyDefaultVersioning(
  agg: Aggregate,
  doc: LangiumDocument,
  inv: Inventory,
  buildRef: BuildRef,
): void {
  if ((agg as { persistedAs?: string }).persistedAs === "eventLog") return;
  const already = (agg as { [CAPABILITIES_TAG]?: string[] })[CAPABILITIES_TAG] ?? [];
  if (already.includes("versioned")) return;
  const cap = inv.Capability.get("versioned");
  if (!cap) return; // the prelude always provides it; stay defensive
  expandCapability(cap, agg, "aggregate", agg, doc, buildRef);
}

function expandOneCall(
  call: MacroCall,
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext | Api,
  hostKind: "aggregate" | "ui" | "context" | "api",
  doc: LangiumDocument,
  inv: Inventory,
  buildRef: BuildRef,
): void {
  const name = call.name;
  if (!name) return;
  const macro = lookupMacro(name);
  if (!macro) {
    // No macro by this name — try a typed capability (typed-capabilities.md).
    // Macro wins on a name collision (a stdlib macro shadows a same-named
    // capability) until the stdlib migrates in Phase 3; that keeps this
    // purely additive.
    const cap = inv.Capability.get(name);
    if (cap) {
      expandCapability(cap, host, hostKind, call, doc, buildRef);
      return;
    }
    recordDiagnostic(doc, {
      severity: "error",
      message: `Unknown macro or capability '${name}'.  Available macros: ${listMacroNames()}.`,
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
  const argResult = bindArgs(macro, call, inv, (d) => recordDiagnostic(doc, d), true);
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

/** Expand a typed-capability reference (`aggregate Order with auditable`, or
 * context-level `context Sales with auditable`): deep-clone each of the
 * capability's members (`Property` / `FilterDecl` / `StampDecl`) into the
 * implementing aggregate(s)' `members[]`, indistinguishable from hand-written
 * ones.  Cloning (not aliasing) is required because the same capability is
 * implemented by many aggregates — one AST node can't live under N parents —
 * and each clone's cross-references are rebuilt as PLAIN `{ $refText }`
 * references (via `buildCapabilityRef`), NOT the Linker's `buildReference`.
 * These resolve leniently: lowering reads `$refText` directly and the linker
 * never surfaces a "could not resolve" diagnostic — matching the field/filter/
 * stamp macros these capabilities replace (see `buildCapabilityRef` above).
 * Lowering then reads the spliced members structurally
 * (`collectFilters`/`collectStamps` + standard field lowering), so a capability
 * and the equivalent hand-written filter/stamp/field produce byte-identical IR.
 *
 * Scope (typed-capabilities.md):
 *   - aggregate `with` — splice into that aggregate.
 *   - context `with` — splice an independent clone into EVERY aggregate in the
 *     context (the `*ByDefault` replacement).  An aggregate that already
 *     declares a same-named member wins (override-by-name in `spliceMembers`).
 * A capability is a pure mixin, so it never targets a `ui`. */
function expandCapability(
  cap: Capability,
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext | Api,
  hostKind: "aggregate" | "ui" | "context" | "api",
  // The AST node the application was written at (a `with` MacroCall or an
  // `implements` ImplementsDecl) — used only as the diagnostic anchor.
  at: AstNode,
  doc: LangiumDocument,
  buildRef: BuildRef,
): void {
  if (hostKind === "ui" || hostKind === "api") {
    recordDiagnostic(doc, {
      severity: "error",
      message:
        `Capability '${cap.name}' can only be applied to an aggregate or context (got '${hostKind}').  ` +
        "A capability is a pure mixin over domain state, not a UI or API concern.",
      node: at,
    });
    return;
  }
  // One fresh clone-set per destination aggregate — a context `with` fans out
  // to every child aggregate; an aggregate `with` is the single-target case.
  const targets =
    hostKind === "aggregate"
      ? [host as Aggregate]
      : ((host as import("../language/generated/ast.js").BoundedContext).members ?? []).filter(
          isAggregate,
        );
  for (const agg of targets) {
    const cloned: unknown[] = (cap.members ?? []).map((m) => AstUtils.copyAstNode(m, buildRef));
    for (const m of cloned) {
      resolveSelfTypes(m as AstNode, agg.name, buildRef);
      // Tag a spliced `filter` member with the capability that contributed it,
      // so lowering can populate `contextFilterOrigins` — the provenance the
      // `ignoring <Cap>` bypass surface resolves against.  Transient ($-key),
      // set after the copy above.
      if ((m as AstNode).$type === "FilterDecl") {
        (m as { [FILTER_ORIGIN_TAG]?: string })[FILTER_ORIGIN_TAG] = cap.name;
      }
    }
    spliceMembers(agg, "aggregate", cloned, at, doc);
    // Record capability membership as a transient annotation on the aggregate
    // node (read by lowering's `collectCapabilities`).  Deliberately NOT an
    // `implements <Cap>` AST member — that would re-trigger the typed-implements
    // scan in `expandHost` and double-apply the capability.
    const slot = agg as { [CAPABILITIES_TAG]?: string[] };
    if (!slot[CAPABILITIES_TAG]) slot[CAPABILITIES_TAG] = [];
    slot[CAPABILITIES_TAG].push(cap.name);
  }
}

/** Rewrite every `Self id` base in a cloned capability member to `<hostName> id`
 * (typed-capabilities.md, the anchored `Self` type).  `Self` resolves to the
 * implementing aggregate's own type, so by splice time the member carries a
 * concrete `IdType` — lowering and the backends never see a `SelfType`. */
function resolveSelfTypes(root: AstNode, hostName: string, buildRef: BuildRef): void {
  const selfs = [...AstUtils.streamAllContents(root)].filter((n) => n.$type === "SelfType");
  for (const node of selfs) {
    const container = node.$container as Record<string, unknown> | undefined;
    if (!container || node.$containerProperty !== "base") continue;
    const idNode: Record<string, unknown> = { $type: "IdType" };
    idNode.target = buildRef(idNode as never, "target", undefined, hostName, undefined as never);
    idNode.$container = container;
    idNode.$containerProperty = "base";
    container.base = idNode;
  }
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
  host: Aggregate | Ui | import("../language/generated/ast.js").BoundedContext | Api,
  hostKind: "aggregate" | "ui" | "context" | "api",
  members: unknown[],
  // Diagnostic anchor: a `with` MacroCall or an `implements` ImplementsDecl.
  call: AstNode,
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

/** The AST array property a synthesised member is spliced into.  Almost every
 * host stores its members in `members[]`; an `Api` host stores its transport
 * bindings in `routes[]` instead (an api-targeted macro emits `Route`s). */
function memberListKey(target: object): "members" | "routes" {
  return (target as { $type?: string }).$type === "Api" ? "routes" : "members";
}

/** Merge synthesised `members` into `target.members[]` (or `target.routes[]`
 * for an api host), scope-locally.
 *
 * Override-by-name and de-duplication are *scoped*: an existing member (an
 * explicit declaration, or one already merged) suppresses a synthesised member
 * of the same name only within the *same* container.  Two same-named `area`
 * blocks merge — their children combine recursively — so role-named pages
 * (`page List` repeated across per-aggregate `area Orders` / `area Products`
 * blocks) no longer collapse onto the first area's copy.  Wires the `$container`
 * triple on every appended node. */
function spliceIntoTarget(target: object, members: unknown[]): void {
  const key = memberListKey(target);
  if (!Array.isArray((target as Record<string, unknown>)[key])) return;
  mergeScopedMembers(target, members, key);
}

/** Append `incoming` into `container[key]` (`members` or `routes`), honouring
 *  scope-local override-by-name and merging same-named child `area` blocks
 *  recursively.  Routes carry no `name`, so they always append. */
function mergeScopedMembers(
  container: object,
  incoming: unknown[],
  key: "members" | "routes" = "members",
): void {
  const list = (container as Record<string, unknown[]>)[key]!;
  const append = (m: unknown): void => {
    (m as Record<string, unknown>).$container = container;
    (m as Record<string, unknown>).$containerProperty = key;
    (m as Record<string, unknown>).$containerIndex = list.length;
    list.push(m);
  };
  const nameOf = (m: unknown): unknown => (m as { name?: unknown }).name;
  const isAreaNode = (m: unknown): boolean => (m as { $type?: unknown }).$type === "Area";

  for (const m of incoming) {
    const name = nameOf(m);
    if (isAreaNode(m)) {
      // Merge into a same-named `area` already at this scope (the same
      // aggregate scaffolded twice, or an explicit area the user opened);
      // otherwise the whole synthesised area is new — append it intact.
      const existing = list.find((x) => isAreaNode(x) && nameOf(x) === name);
      if (existing) {
        mergeScopedMembers(existing as object, (m as { members?: unknown[] }).members ?? []);
        continue;
      }
      append(m);
    } else if (typeof name === "string" && list.some((x) => nameOf(x) === name)) {
      // suppressed by an existing same-named member at this scope (an explicit
      // override-by-name, or a prior synthesised member) — drop it.
    } else {
      append(m);
    }
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
  // When expanding (the pre-link IndexedContent pass) we suppress the
  // "references unknown <kind>" ref-resolution diagnostics: at that point the
  // workspace may still be loading sibling files, so a cross-file ref-list
  // argument can spuriously appear unresolved.  Those errors are re-checked
  // against the settled workspace at validation time via
  // `collectUnresolvedMacroRefs`, which re-runs on every (re)validation.
  silentRefs = false,
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
    const v = coerceArg(macro.name, name, arg, ps, inv, record, silentRefs);
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
  silentRefs = false,
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
          if (!silentRefs) {
            record({
              severity: "error",
              message: `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
              node: arg,
              property: "value",
            });
          }
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
            if (!silentRefs) {
              record({
                severity: "error",
                message: `Argument '${argName}' to macro '${macroName}' references unknown ${spec.of} '${refText}'.`,
                node: arg,
                property: "value",
              });
            }
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

// ---------------------------------------------------------------------------
// Macro ref-argument re-resolution + dependency tracking
// ---------------------------------------------------------------------------

/** One `ref` / `refList` element of a macro call, with the declaration kind
 * its param spec expects. */
type MacroRefVisitor = (
  kind: NamedDeclKind,
  name: string,
  arg: MacroArg,
  macroName: string,
) => void;

/** Walk every macro host in `model` and visit each `ref` / `refList` argument
 * element (name + expected declaration kind).  Shared by the validator's
 * diagnostic re-check and the dependency capture below so the two never drift. */
function forEachMacroRef(model: Model, visit: MacroRefVisitor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isAggregate(node) && !isUi(node) && !isBoundedContext(node) && !isApi(node)) continue;
    const host = node as
      | Aggregate
      | Ui
      | import("../language/generated/ast.js").BoundedContext
      | Api;
    for (const call of host.withClause?.calls ?? []) {
      const macro = call.name ? lookupMacro(call.name) : undefined;
      if (!macro?.params) continue;
      for (const arg of call.args ?? []) {
        const ps = arg.name ? macro.params[arg.name] : undefined;
        if (!ps) continue;
        const v = arg.value;
        if (ps.kind === "ref" && v.$type === "MacroArgRef") {
          const t = readArgRef(v);
          if (t) visit(ps.of, t, arg, macro.name);
        } else if (ps.kind === "refList" && v.$type === "MacroArgRefList") {
          for (const t of readArgRefs(v)) {
            if (t) visit(ps.of, t, arg, macro.name);
          }
        }
      }
    }
  }
}

/** What a document's macro ref-arguments currently depend on — the macro-side
 * analogue of Langium's reference index.  Recorded by the validator on every
 * (re)validation and read by the `isAffected` override in `ddd-module.ts`. */
export interface MacroRefDeps {
  /** At least one ref/refList element did not resolve against the workspace. */
  unresolved: boolean;
  /** `toString()` URIs of the documents that currently provide the resolved
   * refs — so a change to (or removal of) one of them re-validates this host. */
  providers: Set<string>;
}

const _macroDepsByDoc = new WeakMap<LangiumDocument, MacroRefDeps>();

/** The macro ref-dependency record captured for `document` at its last
 * validation, or `undefined` if it has not been validated. */
export function getMacroRefDeps(document: LangiumDocument): MacroRefDeps | undefined {
  return _macroDepsByDoc.get(document);
}

/** Re-check every macro call's `ref` / `refList` arguments against the
 * *settled* workspace, reporting any that name a declaration which still
 * doesn't exist, and record the document's ref-dependency footprint.
 *
 * The expansion pass runs once at IndexedContent — before sibling files may
 * have loaded — and therefore stays silent about unresolved refs.  This runs
 * from the validator on every (re)validation with a workspace-aware inventory,
 * so a cross-file `with scaffold(subdomains: [...])` clears the moment its
 * target file is indexed and a genuinely unknown ref keeps erroring.  The
 * captured `MacroRefDeps` let `ddd-module.ts`'s `isAffected` re-validate a host
 * precisely — when it is still unresolved, or when a file it resolved into
 * changes/is removed — instead of on every workspace edit. */
export function collectUnresolvedMacroRefs(
  model: Model,
  shared: LangiumSharedServices | undefined,
  record: DiagnosticRecorder,
): void {
  const inv = buildInventory(model, shared);
  const providers = new Set<string>();
  let unresolved = false;
  forEachMacroRef(model, (kind, name, arg, macroName) => {
    const target = resolveRef(inv, kind, name);
    if (target) {
      providers.add(AstUtils.getDocument(target).uri.toString());
      return;
    }
    unresolved = true;
    record({
      severity: "error",
      message: `Argument '${arg.name}' to macro '${macroName}' references unknown ${kind} '${name}'.`,
      node: arg,
      property: "value",
    });
  });
  _macroDepsByDoc.set(AstUtils.getDocument(model), { unresolved, providers });
}

function resolveRef(inv: Inventory, kind: NamedDeclKind, name: string): AstNode | undefined {
  return inv[kind].get(name);
}

function listMacroNames(): string {
  const names = allMacros().map((m) => m.name);
  return names.length ? names.join(", ") : "(none registered)";
}
