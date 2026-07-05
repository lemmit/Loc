import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
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
} from "../ir/types/loom-ir.js";
import { descriptorFor } from "../platform/metadata.js";
import { lines } from "../util/code-builder.js";

// ---------------------------------------------------------------------------
// Mermaid artifacts derived from the Loom IR — the same source of truth
// wire-spec.json reads.  Two complementary views:
//
//   .loom/domain.mmd     — a classDiagram of the domain: aggregates,
//                          entity parts, value objects, events,
//                          repositories, enums and views, each with
//                          their attributes + operations, plus the
//                          relationships between them (containment,
//                          X id references, value-object use,
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
// Mermaid's tilde notation (`Id~Order~` renders as `Order id`) so the
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
    case "action":
    case "slot":
      return "slot";
    case "genericInstance":
      return `${typeName(t.arg)} ${t.ctor}`;
    case "union":
      return t.variants.map(typeName).join(" or ");
    case "none":
      return "none";
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
    case "genericInstance":
      refsOfKind(t.arg, kind, out);
      return;
    case "primitive":
    case "entity":
    case "action":
    case "slot":
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

  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      classes.push(`  %% ${m.name} / ${c.name}`);
      for (const e of c.enums) classes.push(...enumClass(e.name, e.values));
      for (const v of c.valueObjects) classes.push(...valueObjectClass(v));
      for (const ev of c.events) {
        classes.push(...simpleClass(ev.name, "event", ev.fields));
        // Events carry X id fields — wire those as data references.
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
        const finds = r.finds.map(
          (f) => `+${f.name}(${params(f.params)}) ${typeName(f.returnType)}`,
        );
        classes.push(...classBlock(r.name, "repository", finds));
        rel(`  ${r.name} ..> ${r.aggregateName} : manages`);
      }
      for (const v of c.views) {
        classes.push(...classBlock(v.name, "view", []));
        rel(`  ${v.name} ..> ${v.source.name} : reads`);
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
  return classBlock(
    name,
    "enumeration",
    values.map((v) => `+${v}`),
  );
}

function classBlock(name: string, stereo: string, members: string[]): string[] {
  return [`  class ${name} {`, `    <<${stereo}>>`, ...members.map((m) => `    ${m}`), `  }`];
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
  for (const m of sys.subdomains) {
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
    case "repo-run":
      return {
        id,
        decl: `${id}["${label(`${s.name} = ${s.repoName}.run(${s.retrievalName})`)}"]`,
      };
    case "for-each":
      return { id, decl: `${id}["${label(`for ${s.var} in ...`)}"]` };
    case "if-let":
      return {
        id,
        decl: `${id}{"${label(`if let ${s.var} = ${s.repoName}.find(${s.synthCriterion.name})`)}"}`,
      };
    case "expr-let":
      return { id, decl: `${id}["${label(`let ${s.name}`)}"]` };
    case "assign":
      return { id, decl: `${id}["${label(`${s.target.segments.join(".")} := ...`)}"]` };
    case "op-call":
      return { id, decl: `${id}["${label(`${s.target}.${s.op}()`)}"]` };
    case "resource-call": {
      const op = s.call.kind === "call" ? s.call.resourceOp : undefined;
      return { id, decl: `${id}["${label(`${op?.resourceName}.${op?.verb}()`)}"]` };
    }
    case "domain-service-call":
      return { id, decl: `${id}["${label(`${s.service}.${s.op}()`)}"]` };
  }
}

// ===========================================================================
// ER diagram — persistence-shaped view
// ===========================================================================

function unwrapType(t: TypeIR): TypeIR {
  if (t.kind === "array") return unwrapType(t.element);
  if (t.kind === "optional") return unwrapType(t.inner);
  return t;
}

// ER attribute types must be single identifier tokens — no angle
// brackets / `[]` / `?`.  X id becomes `Id_X`; collections/optionals
// collapse to their base type.
function erType(t: TypeIR): string {
  const u = unwrapType(t);
  switch (u.kind) {
    case "primitive":
      return u.name;
    case "id":
      return `Id_${u.targetName}`;
    case "enum":
    case "valueobject":
    case "entity":
      return u.name;
    default:
      return "value";
  }
}

function erAttr(f: FieldIR): string {
  const fk = unwrapType(f.type).kind === "id" ? " FK" : "";
  return `${erType(f.type)} ${f.name}${fk}`;
}

function erEntity(name: string, attrs: string[]): string[] {
  return [`  ${name} {`, ...attrs.map((a) => `    ${a}`), `  }`];
}

export function buildErDiagram(sys: SystemIR): string {
  const entities: string[] = [];
  const rels = new Set<string>();
  const rel = (s: string): void => void rels.add(s);

  const erFieldRels = (owner: string, fields: FieldIR[], c: BoundedContextIR): void => {
    const voNames = new Set(c.valueObjects.map((v) => v.name));
    for (const f of fields) {
      const u = unwrapType(f.type);
      if (u.kind === "id" && u.targetName !== owner) {
        rel(`  ${owner} }o--|| ${u.targetName} : "${f.name}"`);
      } else if (u.kind === "valueobject" && voNames.has(u.name)) {
        rel(`  ${owner} ||--|| ${u.name} : "${f.name}"`);
      }
    }
  };

  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) {
        entities.push(...erEntity(a.name, [`${a.idValueType} id PK`, ...a.fields.map(erAttr)]));
        for (const con of a.contains) {
          rel(
            `  ${a.name} ${con.collection ? "||--o{" : "||--||"} ${con.partName} : "${con.name}"`,
          );
        }
        erFieldRels(a.name, a.fields, c);
        for (const p of a.parts) {
          entities.push(...erEntity(p.name, p.fields.map(erAttr)));
          for (const con of p.contains) {
            rel(
              `  ${p.name} ${con.collection ? "||--o{" : "||--||"} ${con.partName} : "${con.name}"`,
            );
          }
          erFieldRels(p.name, p.fields, c);
        }
      }
      for (const v of c.valueObjects) {
        entities.push(...erEntity(v.name, v.fields.map(erAttr)));
      }
    }
  }

  return lines(
    `%% Loom ER diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `erDiagram`,
    entities,
    [...rels],
  );
}

// ===========================================================================
// Sequence diagram — workflow interactions over time
// ===========================================================================

export function buildSequenceDiagram(sys: SystemIR): string {
  const wfs: { ctx: string; wf: WorkflowIR }[] = [];
  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const wf of c.workflows) wfs.push({ ctx: c.name, wf });
    }
  }

  const head = [
    `%% Loom sequence diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `sequenceDiagram`,
  ];

  if (wfs.length === 0) {
    return lines(...head, `  note over WF: No workflows declared in this system.`);
  }

  // Collect the lifelines each workflow talks to so participants are
  // declared up front (stable left-to-right order).
  const partners = new Set<string>();
  for (const { wf } of wfs) {
    for (const s of wf.statements) {
      if (s.kind === "repo-let") partners.add(s.repoName);
      else if (s.kind === "factory-let") partners.add(s.aggName);
      else if (s.kind === "op-call") partners.add(s.aggName);
    }
  }

  const body: string[] = [];
  for (const { ctx, wf } of wfs) {
    body.push(`  note over WF: ${label(`${ctx} · ${wf.name}(${params(wf.params)})`)}`);
    for (const s of wf.statements) body.push(...sequenceMessages(s));
  }

  return lines(
    ...head,
    `  autonumber`,
    `  participant WF as Workflow`,
    [...partners].sort().map((p) => `  participant ${p}`),
    body,
  );
}

function sequenceMessages(s: WorkflowStmtIR): string[] {
  switch (s.kind) {
    case "precondition":
    case "requires":
      return [`  note over WF: ${label(`${s.kind}: ${s.source}`)}`];
    case "emit":
      return [`  note over WF: ${label(`emit ${s.eventName}`)}`];
    case "factory-let":
      return [`  WF->>${s.aggName}: create()`, `  ${s.aggName}-->>WF: ${s.name}`];
    case "repo-let":
      return [`  WF->>${s.repoName}: ${s.method}()`, `  ${s.repoName}-->>WF: ${s.name}`];
    case "op-call":
      return [`  WF->>${s.aggName}: ${s.op}()`];
    case "repo-run":
      return [
        `  WF->>${s.repoName}: run(${s.retrievalName})`,
        `  ${s.repoName}-->>WF: ${s.name}[]`,
      ];
    case "for-each":
      return [
        `  note over WF: ${label(`for ${s.var} in ${s.varAggName}[]`)}`,
        ...s.body.flatMap(sequenceMessages),
      ];
    case "if-let":
      return [
        `  WF->>${s.repoName}: find(${s.synthCriterion.name})`,
        `  ${s.repoName}-->>WF: ${s.var}?`,
        `  note over WF: ${label(`if let ${s.var}`)}`,
        ...s.thenBody.flatMap(sequenceMessages),
        ...((s.elseBody ?? []).length > 0
          ? [`  note over WF: else`, ...(s.elseBody ?? []).flatMap(sequenceMessages)]
          : []),
      ];
    case "expr-let":
      return [];
    case "assign":
      return [`  note over WF: ${label(`${s.target.segments.join(".")} := ...`)}`];
    case "resource-call": {
      const op = s.call.kind === "call" ? s.call.resourceOp : undefined;
      return [`  WF->>${op?.resourceName ?? "resource"}: ${op?.verb ?? "op"}()`];
    }
    case "domain-service-call":
      return [`  WF->>${s.service}: ${s.op}()`];
  }
}

// ===========================================================================
// Deployment topology — flowchart of deployables ↔ modules
// ===========================================================================

const nid = (...parts: string[]): string =>
  parts.map((p) => p.replace(/[^A-Za-z0-9_]/g, "_")).join("_");

export function buildDeploymentDiagram(sys: SystemIR): string {
  const head = [
    `%% Loom deployment diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `flowchart LR`,
  ];

  if (sys.deployables.length === 0) {
    return lines(...head, `  none["No deployables declared in this system."]`);
  }

  // Every context referenced anywhere — owned by a subdomain and/or served by
  // a deployable.  DEFINE these nodes: the deployable→context edges below used
  // to point at `ctx_*` ids that were never declared, so the one diagram whose
  // job is module→context ownership silently rendered bare auto-nodes and never
  // showed the ownership at all.
  const ownedByModule = new Map<string, string[]>();
  const definedCtx = new Set<string>();
  for (const m of sys.subdomains) {
    const owned = m.contexts.map((c) => c.name);
    ownedByModule.set(m.name, owned);
    for (const c of owned) definedCtx.add(c);
  }
  for (const d of sys.deployables) {
    for (const ctx of d.contextNames) definedCtx.add(ctx);
  }

  // Domain group: each subdomain (📦) with the contexts (📁) it owns nested
  // inside, so subdomain→context ownership reads off the diagram directly.
  const domain: string[] = [`  subgraph domain["🗂️ Domain"]`, `    direction TB`];
  const ungrouped = new Set(definedCtx);
  for (const m of sys.subdomains) {
    domain.push(`    subgraph ${nid("mod", m.name)}["📦 ${label(m.name)}"]`);
    domain.push(`      direction TB`);
    for (const ctx of ownedByModule.get(m.name) ?? []) {
      domain.push(`      ${nid("ctx", ctx)}["📁 ${label(ctx)}"]`);
      ungrouped.delete(ctx);
    }
    domain.push(`    end`);
  }
  // Contexts served by a deployable but not owned by any subdomain — still
  // define them so the served-by edge lands on a real node.
  for (const ctx of ungrouped) {
    domain.push(`    ${nid("ctx", ctx)}["📁 ${label(ctx)}"]`);
  }
  domain.push(`  end`);

  const cluster: string[] = [
    `  subgraph deployables["🚀 Deployables"]`,
    `    direction TB`,
    ...sys.deployables.map(
      (d: DeployableIR) =>
        `    ${nid("deploy", d.name)}{{"${label(`${d.name} · ${d.platform}`)}"}}`,
    ),
    `  end`,
  ];

  const edges: string[] = [];
  const known = new Set(sys.deployables.map((d) => d.name));
  for (const d of sys.deployables) {
    // A frontend's `contextNames` are inherited wire-scope, not domain
    // ownership — draw `serves` edges only from the deployable that actually
    // owns the context (a backend).  The frontend's whole relationship to the
    // domain is its `calls` edge to the backend below.
    if (!descriptorFor(d.platform).isFrontend) {
      for (const ctx of d.contextNames)
        edges.push(`  ${nid("deploy", d.name)} -->|serves| ${nid("ctx", ctx)}`);
    }
    if (d.targetName && known.has(d.targetName)) {
      edges.push(`  ${nid("deploy", d.name)} -.->|calls| ${nid("deploy", d.targetName)}`);
    }
  }

  return lines(...head, domain, cluster, edges);
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

export function renderErDiagram(sys: SystemIR): string {
  return buildErDiagram(sys) + "\n";
}

export function renderSequenceDiagram(sys: SystemIR): string {
  return buildSequenceDiagram(sys) + "\n";
}

export function renderDeploymentDiagram(sys: SystemIR): string {
  return buildDeploymentDiagram(sys) + "\n";
}
