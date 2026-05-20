import { lines } from "../util/code-builder.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DerivedIR,
  EntityPartIR,
  FieldIR,
  FunctionIR,
  OperationIR,
  ParamIR,
  SystemIR,
  TypeIR,
  ValueObjectIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Mermaid artifacts derived from the Loom IR — the same source of truth
// wire-spec.json reads.  Two complementary views:
//
//   .loom/domain.mmd     — a classDiagram of the domain: aggregates,
//                          entity parts, value objects, events,
//                          repositories, enums and views, each with
//                          their attributes + operations, plus the
//                          relationships between them (containment,
//                          Id<X> references, value-object use,
//                          repository/view backing).
//
//   .loom/workflows.mmd  — a flowchart per workflow built from its call
//                          sequence (factory creates, repository loads,
//                          aggregate operation calls, emits, guards).
//
// Both are derived views, not contracts — like wire-spec.json.  No DSL
// keyword drives them; a future `diagram { ... }` feature, if wanted,
// would lower into these same emitters.
//
// Class ids are the bare type names: Loom type names are unique within
// a system in practice, which keeps the Mermaid readable.  (Two
// contexts declaring the same type name would merge in the diagram —
// acceptable for a structural overview.)
// ---------------------------------------------------------------------------

const label = (s: string): string => s.replace(/"/g, "&quot;");

// Render a TypeIR to a compact Mermaid-friendly string.  Generics use
// Mermaid's tilde notation (`Id~Order~` renders as `Id<Order>`) so the
// raw angle brackets don't trip the parser.
function typeName(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `Id~${t.targetName}~`;
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `${typeName(t.element)}[]`;
    case "optional":
      return `${typeName(t.inner)}?`;
  }
}

const params = (ps: ParamIR[]): string => ps.map((p) => p.name).join(", ");

// Walk a type collecting referenced type names of a given kind — used
// to derive reference / value-object / enum-use edges from field types.
function refsOfKind(t: TypeIR, kind: "id" | "valueobject" | "enum", out: Set<string>): void {
  switch (t.kind) {
    case "id":
      if (kind === "id") out.add(t.targetName);
      return;
    case "valueobject":
      if (kind === "valueobject") out.add(t.name);
      return;
    case "enum":
      if (kind === "enum") out.add(t.name);
      return;
    case "array":
      refsOfKind(t.element, kind, out);
      return;
    case "optional":
      refsOfKind(t.inner, kind, out);
      return;
    case "primitive":
    case "entity":
      return;
  }
}

// ===========================================================================
// Domain class diagram
// ===========================================================================

export function buildDomainDiagram(sys: SystemIR): string {
  const classes: string[] = [];
  const rels = new Set<string>();
  const rel = (s: string): void => void rels.add(s);

  for (const m of sys.modules) {
    for (const c of m.contexts) {
      classes.push(`  %% ${m.name} / ${c.name}`);
      for (const e of c.enums) classes.push(...enumClass(e.name, e.values));
      for (const v of c.valueObjects) classes.push(...valueObjectClass(v));
      for (const ev of c.events) {
        classes.push(...simpleClass(ev.name, "event", ev.fields));
        // Events carry Id<X> fields — wire those as data references.
        collectFieldEdges(ev.name, ev.fields, c, rel);
      }
      for (const a of c.aggregates) {
        classes.push(...aggregateClass(a));
        collectFieldEdges(a.name, a.fields, c, rel);
        for (const con of a.contains) {
          rel(`  ${a.name} *-- "${con.collection ? "*" : "1"}" ${con.partName} : ${con.name}`);
        }
        // Producer edges: an operation that emits an event wires the
        // aggregate to that event.  (Loom has no consumer construct —
        // nothing subscribes to events — so there is no consume side.)
        for (const op of a.operations) {
          for (const st of op.statements) {
            if (st.kind === "emit") rel(`  ${a.name} ..> ${st.eventName} : emits`);
          }
        }
        // Entity parts are declared inside their owning aggregate.
        for (const p of a.parts) {
          classes.push(...partClass(p));
          collectFieldEdges(p.name, p.fields, c, rel);
          for (const con of p.contains) {
            rel(`  ${p.name} *-- "${con.collection ? "*" : "1"}" ${con.partName} : ${con.name}`);
          }
        }
      }
      for (const r of c.repositories) {
        const finds = r.finds.map((f) => `+${f.name}(${params(f.params)}) ${typeName(f.returnType)}`);
        classes.push(...classBlock(r.name, "repository", finds));
        rel(`  ${r.name} ..> ${r.aggregateName} : manages`);
      }
      for (const v of c.views) {
        classes.push(...classBlock(v.name, "view", []));
        rel(`  ${v.name} ..> ${v.aggregateName} : reads`);
      }
    }
  }

  return lines(
    `%% Loom domain diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `classDiagram`,
    `  direction LR`,
    classes,
    [...rels],
  );
}

function aggregateClass(a: AggregateIR): string[] {
  const members = [
    `+Id~${a.name}~ id`,
    ...a.fields.map(fieldMember),
    ...a.derived.map(derivedMember),
    ...a.functions.map(functionMember),
    ...a.operations.map(operationMember),
  ];
  return classBlock(a.name, "aggregate", members);
}

function partClass(p: EntityPartIR): string[] {
  const members = [
    ...p.fields.map(fieldMember),
    ...p.derived.map(derivedMember),
    ...p.functions.map(functionMember),
  ];
  return classBlock(p.name, "entity", members);
}

function valueObjectClass(v: ValueObjectIR): string[] {
  const members = [
    ...v.fields.map(fieldMember),
    ...v.derived.map(derivedMember),
    ...v.functions.map(functionMember),
  ];
  return classBlock(v.name, "value", members);
}

function simpleClass(name: string, stereo: string, fields: FieldIR[]): string[] {
  return classBlock(name, stereo, fields.map(fieldMember));
}

function enumClass(name: string, values: string[]): string[] {
  return classBlock(name, "enumeration", values.map((v) => `+${v}`));
}

function classBlock(name: string, stereo: string, members: string[]): string[] {
  return [
    `  class ${name} {`,
    `    <<${stereo}>>`,
    ...members.map((m) => `    ${m}`),
    `  }`,
  ];
}

const fieldMember = (f: FieldIR): string =>
  `+${typeName(f.type)}${f.optional ? "?" : ""} ${f.name}`;

// Derived attributes carry the UML "/" derived marker.
const derivedMember = (d: DerivedIR): string => `+${typeName(d.type)} /${d.name}`;

const functionMember = (fn: FunctionIR): string =>
  `+${fn.name}(${params(fn.params)}) ${typeName(fn.returnType)}`;

// extern operations are user-supplied bodies — marked abstract (`*`).
const operationMember = (op: OperationIR): string =>
  `${op.visibility === "private" ? "-" : "+"}${op.name}(${params(op.params)})${op.extern ? "*" : ""}`;

// Reference / value-object / enum-use edges derived from a type's
// field types.
function collectFieldEdges(
  owner: string,
  fields: FieldIR[],
  c: BoundedContextIR,
  rel: (s: string) => void,
): void {
  const ids = new Set<string>();
  const vos = new Set<string>();
  const enums = new Set<string>();
  for (const f of fields) {
    refsOfKind(f.type, "id", ids);
    refsOfKind(f.type, "valueobject", vos);
    refsOfKind(f.type, "enum", enums);
  }
  for (const target of ids) {
    if (target !== owner) rel(`  ${owner} ..> ${target} : ref`);
  }
  const voNames = new Set(c.valueObjects.map((v) => v.name));
  for (const vo of vos) {
    if (voNames.has(vo)) rel(`  ${owner} ..> ${vo} : uses`);
  }
  const enumNames = new Set(c.enums.map((e) => e.name));
  for (const en of enums) {
    if (enumNames.has(en)) rel(`  ${owner} ..> ${en} : uses`);
  }
}

// ===========================================================================
// Workflow call flowchart
// ===========================================================================

export function buildWorkflowDiagram(sys: SystemIR): string {
  const workflows: { ctx: string; wf: WorkflowIR }[] = [];
  for (const m of sys.modules) {
    for (const c of m.contexts) {
      for (const wf of c.workflows) workflows.push({ ctx: c.name, wf });
    }
  }

  if (workflows.length === 0) {
    return lines(
      `%% Loom workflow diagram — generated from the IR, do not edit by hand.`,
      `%% System: ${sys.name}`,
      `flowchart TD`,
      `  none["No workflows declared in this system."]`,
    );
  }

  return lines(
    `%% Loom workflow diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `flowchart TD`,
    workflows.map(({ ctx, wf }, wi) => workflowSubgraph(ctx, wf, wi)),
  );
}

function workflowSubgraph(ctx: string, wf: WorkflowIR, wi: number): string[] {
  const title = `${ctx} · ${wf.name}(${params(wf.params)})${wf.transactional ? " «tx»" : ""}`;
  const nodes = wf.statements.map((s, si) => stepNode(`w${wi}s${si}`, s));
  const body =
    nodes.length === 0
      ? [`    w${wi}empty["(no steps)"]`]
      : [
          ...nodes.map((n) => `    ${n.decl}`),
          // Chain steps in declared order.
          ...nodes.slice(1).map((n, i) => `    ${nodes[i].id} --> ${n.id}`),
        ];
  return [`  subgraph wf_${wi}["${label(title)}"]`, `    direction TB`, ...body, `  end`];
}

interface StepNode {
  id: string;
  decl: string;
}

// Map a workflow statement to a labelled flowchart node.  Guards are
// hexagons, emits are stadiums, calls/lets are rectangles.
function stepNode(id: string, s: WorkflowStmtIR): StepNode {
  switch (s.kind) {
    case "precondition":
      return { id, decl: `${id}{{"${label(`precondition: ${s.source}`)}"}}` };
    case "requires":
      return { id, decl: `${id}{{"${label(`requires: ${s.source}`)}"}}` };
    case "emit":
      return { id, decl: `${id}(["${label(`emit ${s.eventName}`)}"])` };
    case "factory-let":
      return { id, decl: `${id}["${label(`${s.name} = ${s.aggName}.create()`)}"]` };
    case "repo-let":
      return { id, decl: `${id}["${label(`${s.name} = ${s.repoName}.${s.method}()`)}"]` };
    case "expr-let":
      return { id, decl: `${id}["${label(`let ${s.name}`)}"]` };
    case "op-call":
      return { id, decl: `${id}["${label(`${s.target}.${s.op}()`)}"]` };
  }
}

// ===========================================================================
// Render helpers — serialise with a trailing newline.
// ===========================================================================

export function renderDomainDiagram(sys: SystemIR): string {
  return buildDomainDiagram(sys) + "\n";
}

export function renderWorkflowDiagram(sys: SystemIR): string {
  return buildWorkflowDiagram(sys) + "\n";
}
