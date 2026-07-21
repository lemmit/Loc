// Builder-call resolution (BuilderCall.type is a bare string, not a
// cross-reference) and v2 legacy `Name(args)` rejection for VOs /
// EntityParts.

import { type AstNode, AstUtils, type ValidationAcceptor } from "langium";
import { isInferredContainment } from "../containment.js";
import type { DddServices } from "../ddd-module.js";
import type {
  Aggregate,
  BuilderCall,
  EntityPart,
  Expression,
  Model,
  NameRef,
  PayloadDecl,
  PostfixChain,
  Property,
  Ui,
  ValueObject,
} from "../generated/ast.js";
import {
  isAggregate,
  isBoundedContext,
  isCallSuffix,
  isComponent,
  isContainment,
  isEntityPart,
  isMemberSuffix,
  isNameRef,
  isObjectLit,
  isPayloadDecl,
  isPostfixChain,
  isProperty,
  isStateField,
  isValueObject,
} from "../generated/ast.js";
import { type DddType, resolveTypeRef, T } from "../type-system.js";
import { isWalkerPrimitive } from "../walker-stdlib.js";

/** Bindable page-body inputs — they wire to a `state` field via `bind:`. */
const BINDABLE_INPUTS: ReadonlySet<string> = new Set([
  "Field",
  "NumberField",
  "PasswordField",
  "MultilineField",
  "Toggle",
  "SelectField",
  "FileUpload",
]);

/** A bindable input (`Field`, `Toggle`, …) binds to page `state` through
 *  `bind:`.  Writing `value:` instead — the React habit — is silently dropped
 *  by the walker: the input renders uncontrolled and no `useState` is emitted.
 *  Warn and suggest `bind:` so the silent no-op can't recur. */
export function checkBindableInputArgs(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    if (!BINDABLE_INPUTS.has(bc.type)) continue;
    for (const entry of bc.entries) {
      if (entry.name === "value") {
        accept(
          "warning",
          `'${bc.type}' binds to page state via 'bind:', not 'value:'. Did you mean 'bind: …'? With 'value:' the input renders uncontrolled and the state never wires up.`,
          { node: entry, property: "name", code: "loom.bindable-input-value-arg" },
        );
      }
    }
  }
}

/** Extract the bare state-field name a `bind:` expression references —
 *  a `NameRef` (`bind: docState`) or a suffix-less `PostfixChain` whose
 *  head is a `NameRef`.  Anything else (a member access, a call) isn't a
 *  bare state-field bind, so returns undefined. */
function bareBindName(value: Expression | undefined): string | undefined {
  if (!value) return undefined;
  if (isNameRef(value)) return value.name;
  if (isPostfixChain(value) && value.suffixes.length === 0 && isNameRef(value.head)) {
    return value.head.name;
  }
  return undefined;
}

/** `loom.file-upload-not-file-field` — a `FileUpload { …, bind: x }` (and
 *  the auto-rendered form input of a `File`-typed field) must bind a
 *  `File`-typed page `state` field.  Binding a non-`File` field would emit
 *  a `field.onChange(fileRef)` write against a mistyped state slot; the
 *  gap only surfaces later as a `tsc` mismatch, so reject it here.
 *
 *  Minimal, clear-case only: it resolves the `bind:` name against the
 *  enclosing page/component/store `state {}` fields.  When the name can't
 *  be resolved to a declared state field (an out-of-scope or dynamic ref),
 *  it stays silent — that's a different diagnostic's concern. */
export function checkFileUploadBinding(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    if (bc.type !== "FileUpload") continue;
    const bindEntry = bc.entries.find((e) => e.name === "bind");
    if (!bindEntry) continue; // no bind: — the pack renders an unbound stub
    const name = bareBindName(bindEntry.value);
    if (name === undefined) continue;
    // Resolve the state field within the nearest state-bearing container.
    const container = AstUtils.getContainerOfType(
      bc,
      (n): n is AstNode => n.$type === "Page" || n.$type === "Component" || n.$type === "Store",
    );
    if (!container) continue;
    let field: import("../generated/ast.js").StateField | undefined;
    for (const inner of AstUtils.streamAllContents(container)) {
      if (isStateField(inner) && inner.name === name) {
        field = inner;
        break;
      }
    }
    if (!field) continue; // unresolved ref — not this check's concern
    const t = resolveTypeRef(field.type);
    if (t.kind === "primitive" && t.name === "File") continue;
    accept(
      "error",
      `'FileUpload' must bind a 'File'-typed state field, but '${name}' is ${describeType(t)}. ` +
        `Declare 'state { ${name}: File }' (a FileRef the upload writes back).`,
      { node: bindEntry, property: "value", code: "loom.file-upload-not-file-field" },
    );
  }
}

/** Short human name for a resolved type, for the diagnostic message. */
function describeType(t: DddType): string {
  if (t.kind === "primitive") return `'${t.name}'`;
  if (t.kind === "id") return `an id reference`;
  if (t.kind === "enum") return `an enum`;
  return `not a File`;
}

/** v2 hard cut: reject `Name(args)` invocation forms that v2 replaces
 *  with BuilderCall.  Post grammar flatten, the AST shape is a
 *  `PostfixChain` whose first suffix is a `CallSuffix` and whose head
 *  is a bare `NameRef`.  When `Name` resolves to a ValueObject or
 *  EntityPart in the enclosing context, those constructions must use
 *  `Name { slot: value, ... }` syntax now. */
export function checkLegacyConstructorCalls(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const first = node.suffixes[0];
    if (!first || !isCallSuffix(first)) continue;
    const head = node.head;
    if (head.$type !== "NameRef") continue;
    const name = (head as NameRef).name;
    const ctx = AstUtils.getContainerOfType(node, isBoundedContext);
    let reported = false;
    for (const m of ctx?.members ?? []) {
      if (isValueObject(m) && m.name === name) {
        accept(
          "error",
          `v2 syntax: construct '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
          { node, code: "loom.legacy-vo-call" },
        );
        reported = true;
        break;
      }
      if (isAggregate(m)) {
        for (const inner of m.members) {
          if (inner.$type === "EntityPart" && (inner as EntityPart).name === name) {
            accept(
              "error",
              `v2 syntax: construct entity part '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
              { node, code: "loom.legacy-part-call" },
            );
            reported = true;
            break;
          }
        }
      }
      if (reported) break;
    }
    if (reported) continue;
    // Root-level VO / record payload (the ambient shared kernel — `valueobject`
    // / `error`/`payload`/… at file scope).  `checkBuilderCallType` resolves
    // these by bare name (cases 2b/2c), so their legacy `Name(...)` invocation
    // must be rejected here too — otherwise a file-scope `valueobject Price`
    // lets `Price(1)` pass validation and emit a class-called-as-function (C4).
    if (model.members.some((m) => isValueObject(m) && m.name === name)) {
      accept(
        "error",
        `v2 syntax: construct '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
        { node, code: "loom.legacy-vo-call" },
      );
      continue;
    }
    if (model.members.some((m) => isPayloadDecl(m) && m.name === name && m.variants.length === 0)) {
      accept(
        "error",
        `v2 syntax: construct '${name}' with builder-call form '${name} { ... }', not '${name}(...)'.`,
        { node, code: "loom.legacy-vo-call" },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// `loom.unknown-construction-field` (M-T6.18, slice 1) — a record built with
// `X { field: value, … }` must only name fields the record DECLARES.  A typo'd
// or stale field name (`Money { amount: …, bogus: 3 }`) previously slipped
// through — `checkBuilderCallType` resolves the type NAME but never the entries
// — and mis-generated (`new Money(…, 3)`, a stray positional arg / dropped
// field), caught only downstream by `tsc`/`gradle`/`mix`.  This is the safest
// slice of the systemic parameter-passing gap: an entry name that isn't a
// declared field is unambiguously wrong (no optional / required / derived
// nuance, no type inference, no `Env`).  Completeness + entry-VALUE type checks
// are the follow-on slices.  Scoped to RECORD construction (value object /
// entity part / record payload); walker primitives + components have their own
// arg surfaces and are skipped.
// ---------------------------------------------------------------------------

/** Resolve a `BuilderCall` to the RECORD declaration it constructs — a value
 *  object, an entity part, or a record payload (`error`/`payload`/… with fields,
 *  not a `= A | B` union) — mirroring `checkBuilderCallType`'s record branches.
 *  Returns undefined for walker primitives, components, and unknown names (those
 *  aren't records; `checkBuilderCallType` owns their diagnostics). */
export function resolveRecordDecl(
  bc: BuilderCall,
  model: Model,
): ValueObject | EntityPart | PayloadDecl | undefined {
  const name = bc.type;
  if (isWalkerPrimitive(name)) return undefined;
  const isRecordPayload = (m: unknown): m is PayloadDecl =>
    isPayloadDecl(m) && m.name === name && m.variants.length === 0;
  const ctx = AstUtils.getContainerOfType(bc, isBoundedContext);
  for (const m of ctx?.members ?? []) {
    if (isValueObject(m) && m.name === name) return m;
    if (isRecordPayload(m)) return m;
    if (isAggregate(m)) {
      for (const inner of m.members) {
        if (isEntityPart(inner) && inner.name === name) return inner;
      }
    }
  }
  for (const m of model.members) {
    if (isValueObject(m) && m.name === name) return m;
    if (isRecordPayload(m)) return m;
  }
  return undefined;
}

/** The constructible field names of a record decl.  For a value object / entity
 *  part these are the declared `Property` members plus any `contains` members
 *  (an entity part's nested collections/singletons are set at construction —
 *  `Shipment { carrier: …, labels: [Label { … }] }`).  Derived / invariant /
 *  function members are computed, not constructor inputs.  (`.filter(isProperty)`
 *  over the union-of-member-arrays doesn't narrow, so gather explicitly.) */
function recordFieldNames(decl: ValueObject | EntityPart | PayloadDecl): Set<string> {
  if (isPayloadDecl(decl)) return new Set(decl.fields.map((f) => f.name));
  const names = new Set<string>();
  for (const m of decl.members) {
    if (isProperty(m) || isContainment(m)) names.add(m.name);
  }
  return names;
}

/** The constructible fields of a record decl mapped to their declared TYPE —
 *  the type-checking twin of `recordFieldNames`, consumed by the entry-VALUE
 *  check (`checkConstructionArgTypes` in `statements.ts`, which has the lexical
 *  `Env` to type each entry value).  A `Property` / payload field resolves via
 *  `resolveTypeRef`; a `contains` member is its part type (an array when the
 *  containment is a collection). */
export function recordFieldTypes(
  decl: ValueObject | EntityPart | PayloadDecl,
): Map<string, DddType> {
  const out = new Map<string, DddType>();
  if (isPayloadDecl(decl)) {
    for (const f of decl.fields) out.set(f.name, resolveTypeRef(f.type));
    return out;
  }
  for (const m of decl.members) {
    if (isProperty(m)) {
      out.set(m.name, resolveTypeRef(m.type));
    } else if (isContainment(m)) {
      const part = m.partType?.ref;
      const el: DddType = part ? { kind: "entity", ref: part } : T.unknown;
      out.set(m.name, m.collection ? T.array(el) : el);
    }
  }
  return out;
}

/** The REQUIRED constructor fields of a record decl — a declared `Property`
 *  that is non-optional (`T`, not `T?`), has no `= default`, and isn't
 *  `provenanced` (those are auto-filled at construction).  `contains` members
 *  auto-default to empty and are never required, so only `Property` members are
 *  considered.  Consumed by the completeness check. */
function requiredFieldNames(decl: ValueObject | EntityPart | PayloadDecl): Set<string> {
  const req = new Set<string>();
  const consider = (p: Property) => {
    // A `contains`-less entity-typed field is a containment — it auto-defaults
    // to empty at construction, exactly like an explicit `contains` member, so
    // it is never a required constructor input.
    if (p.type?.optional || p.default || p.provenanced || isInferredContainment(p)) return;
    req.add(p.name);
  };
  if (isPayloadDecl(decl)) {
    for (const f of decl.fields) consider(f);
    return req;
  }
  for (const m of decl.members) if (isProperty(m)) consider(m);
  return req;
}

/** Reject a construction entry whose name isn't a declared field of the record
 *  (`loom.unknown-construction-field`), and a construction that OMITS a required
 *  field (`loom.construction-missing-field`, M-T6.18 — completes the record
 *  construction gap: name + value type + presence).  Both are pure name-set
 *  checks over the model stream, so no lexical env is needed. */
export function checkConstructionFields(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    const decl = resolveRecordDecl(bc, model);
    if (!decl) continue; // not a record — primitive / component / unknown-type
    const fields = recordFieldNames(decl);
    const provided = new Set<string>();
    let hasPositional = false;
    for (const entry of bc.entries) {
      // Positional entries (`Card { "hi" }`) carry no name — not a field ref.
      if (typeof entry.name !== "string") {
        hasPositional = true;
        continue;
      }
      provided.add(entry.name);
      if (!fields.has(entry.name)) {
        accept(
          "error",
          `'${bc.type}' has no field '${entry.name}'.` +
            (fields.size > 0 ? ` Declared fields: ${[...fields].join(", ")}.` : ""),
          { node: entry, property: "name", code: "loom.unknown-construction-field" },
        );
      }
    }
    // Completeness: every required field must be supplied.  Skip when the
    // construction mixes in a positional entry — the provided-set can't be read
    // by name, so requiring fields would risk a false positive.
    if (!hasPositional) {
      const missing = [...requiredFieldNames(decl)].filter((n) => !provided.has(n));
      if (missing.length > 0) {
        accept(
          "error",
          `'${bc.type}' construction is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          { node: bc, property: "type", code: "loom.construction-missing-field" },
        );
      }
    }
  }
}

/** Resolve a bare name to the `Aggregate` it names, scoped from `from` —
 *  the enclosing context first (the common, single-context case), then any
 *  context in the model (a cross-context `Other id` link constructed inline).
 *  `from` is any node inside the scope (a factory-call `NameRef`, or a bare
 *  `BuilderCall` whose type mis-uses the `{ }` literal on an aggregate). */
function resolveAggregateByName(name: string, from: AstNode, model: Model): Aggregate | undefined {
  const ctx = AstUtils.getContainerOfType(from, isBoundedContext);
  for (const m of ctx?.members ?? []) {
    if (isAggregate(m) && m.name === name) return m;
  }
  for (const top of model.members) {
    if (isBoundedContext(top)) {
      for (const m of top.members) {
        if (isAggregate(m) && m.name === name) return m;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `loom.create-unknown-field` / `loom.create-server-field` — validate the
// object-literal argument of an aggregate's crudish factory call
// `Agg.create({ … })`.  The generated factory input is the aggregate's
// create-input contract — declared `Property` members whose access is NOT
// `managed`/`token`/`internal` (the same `forCreateInput` matrix the wire DTO
// and every backend's `create(...)` derive from).  Passing a server-owned
// field (`Task.create({ createdAt: now() })` where `createdAt` is `managed`,
// or a capability-injected `tenantId`/`version`) or a typo'd key parses + emits
// clean, then fails the emitted project's OWN `tsc`/`vitest` (the field isn't
// on the factory input type).  This closes that gap at the call site — the
// factory twin of `loom.unknown-construction-field` for record builders.
//
// Only the crudish RECORD factory form is checked: a single `{ … }`
// object-literal argument.  A custom positional creator (`create(a, b)`) has a
// different arg surface owned by the domain-call-argument gate.
// ---------------------------------------------------------------------------

const SERVER_OWNED_ACCESS: ReadonlySet<string> = new Set(["managed", "token", "internal"]);

export function checkFactoryCreateFields(model: Model, accept: ValidationAcceptor): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (!isPostfixChain(node)) continue;
    const chain = node as PostfixChain;
    const head = chain.head;
    if (!isNameRef(head)) continue;
    const first = chain.suffixes[0];
    // `Agg.create( … )` — first suffix is a call to member `create`.
    if (!first || !isMemberSuffix(first) || !first.call || first.member !== "create") continue;
    // Crudish record factory form only: exactly one object-literal argument.
    if (first.args.length !== 1) continue;
    const argVal = first.args[0]?.value;
    if (!argVal || !isObjectLit(argVal)) continue;
    const agg = resolveAggregateByName(head.name, head, model);
    if (!agg) continue; // head isn't an aggregate (api client, store, …) — skip

    const createInput = new Set<string>();
    const serverOwned = new Map<string, string>();
    for (const m of agg.members) {
      if (!isProperty(m)) continue;
      const access = typeof m.access === "string" ? m.access : "";
      if (SERVER_OWNED_ACCESS.has(access)) serverOwned.set(m.name, access);
      else createInput.add(m.name);
    }

    for (const entry of argVal.fields) {
      const name = typeof entry.name === "string" ? entry.name : String(entry.name);
      if (createInput.has(name)) continue;
      if (serverOwned.has(name)) {
        accept(
          "error",
          `'${agg.name}.create' can't set '${name}' — it's a server-owned (${serverOwned.get(name)}) field, ` +
            `populated automatically and absent from the factory input. Remove it.`,
          { node: entry, property: "name", code: "loom.create-server-field" },
        );
      } else {
        accept(
          "error",
          `'${agg.name}' has no create-input field '${name}'.` +
            (createInput.size > 0 ? ` Create inputs: ${[...createInput].join(", ")}.` : ""),
          { node: entry, property: "name", code: "loom.create-unknown-field" },
        );
      }
    }
  }
}

/** v2 BuilderCall type names are bare strings (no cross-reference) —
 *  resolve them at validation time and reject unknown names with a
 *  diagnostic listing the four admissible categories.
 *
 *  When `services` is provided the lookup falls through to the
 *  workspace-wide index for top-level components declared in
 *  another `.ddd` document; without it (single-document path,
 *  e.g. unit tests) only the document under validation is consulted. */
export function checkBuilderCallType(
  model: Model,
  accept: ValidationAcceptor,
  services?: DddServices,
): void {
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "BuilderCall") continue;
    const bc = node as BuilderCall;
    const name = bc.type;
    // 1. Walker primitive (stdlib).
    if (isWalkerPrimitive(name)) continue;
    // 2. VO / EntityPart in enclosing context.
    const ctx = AstUtils.getContainerOfType(bc, isBoundedContext);
    if (ctx) {
      let resolved = false;
      for (const m of ctx.members) {
        if (isValueObject(m) && m.name === name) {
          resolved = true;
          break;
        }
        // A record payload (`payload`/`command`/`query`/`response`/`error` with
        // fields, not a named `= A | B` union) is a structural record, so it's
        // constructible by the same builder-call form — `NotFound { resource:
        // … }`.  This is the producer-side surface for exception-less returns
        // (exception-less.md); lowering routes the name to an `object` ExprIR.
        if (isPayloadDecl(m) && m.name === name && m.variants.length === 0) {
          resolved = true;
          break;
        }
        if (isAggregate(m)) {
          for (const inner of m.members) {
            if (inner.$type === "EntityPart" && (inner as EntityPart).name === name) {
              resolved = true;
              break;
            }
          }
          if (resolved) break;
        }
      }
      if (resolved) continue;
    }
    // 2b. Root-level value object declared at the top of the SAME document
    //     (the ambient shared kernel — `valueobject` outside any context).
    //     The enclosing context's VOs are checked above; this adds the
    //     file-level ones so `Money { … }` resolves when `Money` is
    //     declared at model scope.  Cross-document root VOs are not
    //     constructible by bare name (the builder-call type is a plain
    //     string, not a linked reference), so only the local document is
    //     consulted — matching the lowering resolver
    //     (`findValueObjectByName` in src/ir/lower/lower-types.ts).
    if (model.members.some((m) => isValueObject(m) && (m as { name: string }).name === name)) {
      continue;
    }
    // 2c. Root-level record payload (`error`/`payload`/… at file scope, the
    //     ambient shared kernel — exception-less.md A1).  Constructible by the
    //     builder-call form like a context-local record payload (case 2),
    //     matching the lowering resolver (`findPayloadByName`'s root fallback).
    if (model.members.some((m) => isPayloadDecl(m) && m.name === name && m.variants.length === 0)) {
      continue;
    }
    // 3. User-defined component in enclosing UI (ui-scope wins on
    //    name collision with a top-level component declared in the
    //    same workspace).
    const ui = AstUtils.getContainerOfType(bc, (n): n is Ui => n.$type === "Ui");
    if (ui) {
      const userComp = ui.members.some(
        (m) => m.$type === "Component" && (m as { name: string }).name === name,
      );
      if (userComp) continue;
    }
    // 4. Top-level component (declared as a `ModelMember` rather than
    //    inside a `ui { … }`).  Workspace-wide via the import-graph
    //    walk; matches by bare name.  Local document checked first
    //    (avoids paying for index lookup when the call lives in the
    //    same file as the declaration); if missing, the workspace
    //    index is consulted so a multi-file project sees a component
    //    declared in any imported sibling.
    const localTopLevel = (model as Model).members.some(
      (m) => isComponent(m) && (m as { name: string }).name === name,
    );
    if (localTopLevel) continue;
    if (services) {
      const index = services.shared.workspace.IndexManager;
      // Don't filter by node type at the index level: a typo-tolerant
      // lookup keeps the surface honest even if the description's
      // `type` doesn't match exactly.  Component descriptions exported
      // by `DddScopeComputation.collectExportedSymbols` carry the bare name,
      // so a name match is sufficient (the corresponding node is
      // checked below to be a Component).
      let workspaceTopLevel = false;
      for (const desc of index.allElements()) {
        if (desc.name !== name) continue;
        if (desc.type === "Component") {
          workspaceTopLevel = true;
          break;
        }
      }
      if (workspaceTopLevel) continue;
    }
    // 5. The name IS a declared aggregate — the author reached for the value-
    //    object `{ }` literal on an aggregate root.  An aggregate has identity
    //    and invariants the factory enforces, so it is constructed through its
    //    `create({ … })` factory, never the bare builder literal.  Special-case
    //    the diagnostic (instead of the generic "unknown builder type" below,
    //    which talks about walker primitives and misroutes the fix) so it names
    //    the actual remedy.
    if (resolveAggregateByName(name, bc, model)) {
      accept(
        "error",
        `'${name}' is an aggregate — construct it with '${name}.create({ … })', not '${name} { … }'. ` +
          `The '{ }' builder literal is for value objects and entity parts.`,
        { node: bc, property: "type", code: "loom.aggregate-not-a-builder" },
      );
      continue;
    }
    accept(
      "error",
      `Unknown builder type '${name}'. Expected a ValueObject, EntityPart, user-defined component, or stdlib walker primitive (e.g., Stack, CreateForm, Card).`,
      { node: bc, property: "type", code: "loom.unknown-builder-type" },
    );
  }
}
