import { emitsRestCreate, forApiRead, forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  ParamIR,
  PayloadIR,
  TypeIR,
  WireField,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId } from "../render-expr.js";
import {
  collectWireImports,
  domainToWire,
  referencedValueObjects,
  type WireDir,
  wireJavaType,
} from "./wire.js";
import { observableWorkflowsOf } from "./workflow-instances.js";

// ---------------------------------------------------------------------------
// Request / response DTO records.  One record per file (Java's rule);
// component order is wireShape order, so the JSON property order matches
// every other backend by construction.  Response records carry a static
// `from(<domain>)` mapper; request mapping to domain values lives in the
// service (it needs the VO constructors).
// ---------------------------------------------------------------------------

export interface DtoFile {
  name: string;
  category: "request-dto" | "response-dto";
  content: string;
}

/** Normalise the optional flag into the type so wire helpers see one
 *  canonical shape. */
function eff(t: TypeIR, optional: boolean): TypeIR {
  return optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;
}

function recordFile(
  pkg: string,
  basePkg: string,
  name: string,
  components: string[],
  body: string[],
  imports: Set<string>,
  entityImport?: string,
): string {
  return lines(
    `package ${pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    entityImport ? entityImport : null,
    ``,
    `public record ${name}(${components.join(", ")}) {`,
    ...body,
    `}`,
    ``,
  );
}

/** All DTO files for one aggregate: nested VO request/response records,
 *  the create request, per-op requests, part responses, the aggregate
 *  response, and the `{ id }` create response. */
export function renderDtoFiles(
  agg: EnrichedAggregateIR,
  voLookup: ReadonlyMap<string, readonly FieldIR[]>,
  pkg: string,
  basePkg: string,
  entityPkg: string,
  /** Event-sourced create-input override: the `create` action's params
   *  (the command shape) replace the field-derived create inputs. */
  esCreateParams?: readonly ParamIR[],
  /** M-T5.10: the context's declared payload records.  When a
   *  `response <Agg>Response` is present it drives the aggregate response DTO
   *  (read-path replacement for the `wireShape` derivation). */
  payloads: readonly PayloadIR[] = [],
): DtoFile[] {
  const out: DtoFile[] = [];
  const entityImport = entityPkg !== pkg ? `import ${entityPkg}.${agg.name};` : undefined;
  const partImport = (partName: string): string | undefined =>
    entityPkg !== pkg ? `import ${entityPkg}.${partName};` : undefined;

  // --- nested value-object records ------------------------------------------
  const voNames = new Set<string>();
  referencedValueObjects(
    forCreateInput(agg.fields).map((f) => f.type),
    voNames,
  );
  for (const op of agg.operations) {
    referencedValueObjects(
      op.params.map((p) => p.type),
      voNames,
    );
  }
  referencedValueObjects(
    (agg.wireShape ?? []).map((w) => w.type),
    voNames,
  );
  for (const part of agg.parts) {
    referencedValueObjects(
      (part.wireShape ?? []).map((w) => w.type),
      voNames,
    );
  }
  // Close over nested VOs (a VO field may itself be a VO).
  const queue = [...voNames];
  while (queue.length > 0) {
    const vo = queue.pop()!;
    const before = voNames.size;
    referencedValueObjects(
      (voLookup.get(vo) ?? []).map((f) => f.type),
      voNames,
    );
    if (voNames.size > before) {
      for (const v of voNames) if (!queue.includes(v)) queue.push(v);
    }
  }
  for (const vo of [...voNames].sort()) {
    const fields = voLookup.get(vo) ?? [];
    out.push(voRecord(vo, fields, "Request", pkg, basePkg));
    out.push(voRecord(vo, fields, "Response", pkg, basePkg));
  }

  // --- create request (aggregates exposing a REST create; event-sourced ones
  // via their `create` action's params) -------------------------
  const createInputs = forCreateInput(agg.fields);
  if (emitsRestCreate(agg)) {
    const imports = new Set<string>();
    const components = (
      esCreateParams ??
      // A field carrying a declared default (`field: T = <expr>`) is optional at
      // the wire boundary: box the primitive so an OMITTED key deserializes to
      // null instead of Jackson 400ing, and let the service materialize the
      // declared default when it is absent (RS-6 / RST-10, parity with
      // node/python).  A field WITHOUT a default keeps its required shape.
      createInputs.map((f) => ({
        name: f.name,
        type: eff(f.type, f.optional || f.default != null),
      }))
    ).map((f) => {
      collectWireImports(f.type, imports);
      return `${wireJavaType(f.type, "Request")} ${f.name}`;
    });
    out.push({
      name: `Create${agg.name}Request.java`,
      category: "request-dto",
      content: recordFile(pkg, basePkg, `Create${agg.name}Request`, components, [], imports),
    });
  }

  // --- per-operation requests (ops with params only) ----------------------------
  for (const op of agg.operations) {
    if (op.params.length === 0) continue;
    const imports = new Set<string>();
    const components = op.params.map((p) => {
      collectWireImports(p.type, imports);
      return `${wireJavaType(p.type, "Request")} ${p.name}`;
    });
    out.push({
      name: `${upperFirst(op.name)}${agg.name}Request.java`,
      category: "request-dto",
      content: recordFile(
        pkg,
        basePkg,
        `${upperFirst(op.name)}${agg.name}Request`,
        components,
        [],
        imports,
      ),
    });
  }

  // --- part responses ------------------------------------------------------------
  for (const part of agg.parts) {
    out.push(wireRecord(part, `${part.name}Response`, pkg, basePkg, partImport(part.name)));
  }

  // --- aggregate response ----------------------------------------------------------
  const declaredRootResponse = payloads.find(
    (p) => p.kind === "response" && p.name === `${agg.name}Response`,
  );
  out.push(
    wireRecord(
      agg,
      `${agg.name}Response`,
      pkg,
      basePkg,
      entityImport,
      declaredRootResponse ? { payload: declaredRootResponse, payloads } : undefined,
    ),
  );

  // --- create response (`{ id }`) ---------------------------------------------------
  if (emitsRestCreate(agg)) {
    const idJava = javaValueTypeForId(agg.idValueType);
    const imports = new Set<string>();
    if (idJava === "UUID") imports.add("java.util.UUID");
    out.push({
      name: `Create${agg.name}Response.java`,
      category: "response-dto",
      content: recordFile(pkg, basePkg, `Create${agg.name}Response`, [`${idJava} id`], [], imports),
    });
  }

  // --- can response (`{ allowed }`) -------------------------------------------------
  // The side-effect-free `can_<op>` companion of a `when`-gated operation
  // (criterion.md, use site 2) returns this shape.  One per aggregate, emitted
  // when the aggregate carries any served `when` gate.
  if (agg.operations.some((op) => op.visibility === "public" && op.when)) {
    out.push({
      name: "CanResponse.java",
      category: "response-dto",
      content: recordFile(pkg, basePkg, "CanResponse", ["boolean allowed"], [], new Set<string>()),
    });
  }

  return out;
}

function voRecord(
  vo: string,
  fields: readonly FieldIR[],
  dir: WireDir,
  pkg: string,
  basePkg: string,
): DtoFile {
  const imports = new Set<string>();
  const components = fields.map((f) => {
    const t = eff(f.type, f.optional);
    collectWireImports(t, imports);
    return `${wireJavaType(t, dir)} ${f.name}`;
  });
  const body =
    dir === "Response"
      ? [
          `    public static ${vo}Response from(${vo} value) {`,
          `        return new ${vo}Response(${fields
            .map((f) => domainToWire(eff(f.type, f.optional), `value.${f.name}()`))
            .join(", ")});`,
          `    }`,
        ]
      : [];
  return {
    name: `${vo}${dir}.java`,
    category: dir === "Request" ? "request-dto" : "response-dto",
    content: recordFile(pkg, basePkg, `${vo}${dir}`, components, body, imports),
  };
}

/** Response record over an entity's wireShape (aggregate root or part).
 *  `forApiRead` drops `internal`/`secret` fields — an internal field
 *  (softDeletable's `isDeleted`) never crosses a read response on any
 *  backend, so the DTO must not carry it either (SquadResponse parity). */
function wireRecord(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  recordName: string,
  pkg: string,
  basePkg: string,
  entityImport?: string,
  /** M-T5.10: when present, the declared `response <Agg>Response` record drives
   *  the DTO's field selection + order + component types instead of `wireShape`.
   *  The `from(<domain>)` mapper is still reconstructed from the domain (a
   *  containment field is already `<Part>Response`, so its mapper peels the
   *  `Response` name to `<Part>Response::from` — never `<Part>ResponseResponse`).
   *  Byte-identical to the `wireShape` path for a scaffolded record. */
  declared?: { payload: PayloadIR; payloads: readonly PayloadIR[] },
): DtoFile {
  const imports = new Set<string>();
  const components: string[] = [];
  const args: string[] = [];
  if (declared) {
    // The record omits `id` (grammar-reserved) — re-prepend it exactly as the
    // wireShape id row derives, so the leading component/mapper match.
    const idW = forApiRead(entity.wireShape ?? []).find((w) => w.source === "id");
    if (idW) {
      const t = wireFieldType(idW);
      collectWireImports(t, imports);
      components.push(`${wireJavaType(t, "Response")} ${idW.name}`);
      args.push(domainToWire(t, `value.${accessor(idW)}`));
    }
    for (const f of declared.payload.fields) {
      components.push(`${payloadFieldJavaType(f, declared.payloads, imports)} ${f.name}`);
      args.push(payloadFieldToWire(f, declared.payloads));
    }
  } else {
    const shape = forApiRead(entity.wireShape ?? []);
    for (const w of shape) {
      const t = wireFieldType(w);
      collectWireImports(t, imports);
      components.push(`${wireJavaType(t, "Response")} ${w.name}`);
      args.push(domainToWire(t, `value.${accessor(w)}`));
    }
  }
  // Co-located provenance (provenance.md): each provenanced field appends a
  // trailing `<field>Provenance` component carrying the current lineage, so any
  // GET surfaces it inline (the field's own value still emits above).  Parts
  // carry no provenanced fields (write sites live on the root), so this is a
  // no-op for them — keeping non-provenance responses byte-identical.
  for (const f of entity.fields.filter((pf) => pf.provenanced)) {
    imports.add(`${basePkg}.domain.common.ProvLineage`);
    components.push(`ProvLineage ${f.name}Provenance`);
    args.push(`value.${f.name}Provenance()`);
  }
  const body = [
    `    public static ${recordName} from(${entity.name} value) {`,
    `        return new ${recordName}(${args.join(", ")});`,
    `    }`,
  ];
  return {
    name: `${recordName}.java`,
    category: "response-dto",
    content: recordFile(pkg, basePkg, recordName, components, body, imports, entityImport),
  };
}

function wireFieldType(w: WireField): TypeIR {
  if (w.source === "id") {
    // The id wire field carries the bare value type.
    return w.type;
  }
  return eff(w.type, w.optional);
}

/** True iff `name` is a declared `response` payload in the context — a
 *  containment field's already-wire type, which must not be re-suffixed. */
function isResponsePayloadName(payloads: readonly PayloadIR[], name: string): boolean {
  return payloads.some((p) => p.kind === "response" && p.name === name);
}

/** Java component type for a field of a DECLARED `response` record.  A
 *  value-object / scalar / enum field carries its DOMAIN type, so `wireJavaType`
 *  maps it exactly as the wireShape path does; a CONTAINMENT field is ALREADY
 *  the wire name (`lines: LineResponse[]` — context scope can't reference a raw
 *  entity part, so PR1 rewrote it to the sibling `<Part>Response` record, which
 *  lowers to an `entity` whose name is a declared `response`).  That name is
 *  rendered DIRECTLY (peel + re-wrap `List<...>`); running it through
 *  `wireJavaType` would append a second `Response` (`LineResponseResponse`). */
function payloadFieldJavaType(
  f: FieldIR,
  payloads: readonly PayloadIR[],
  imports: Set<string>,
): string {
  const t = eff(f.type, f.optional);
  const base = t.kind === "array" ? t.element : t;
  if (base.kind === "entity" && isResponsePayloadName(payloads, base.name)) {
    if (t.kind === "array") {
      imports.add("java.util.List");
      return `List<${base.name}>`;
    }
    return base.name;
  }
  collectWireImports(t, imports);
  return wireJavaType(t, "Response");
}

/** The `from(<domain>)` mapper argument for a DECLARED `response` field.  A
 *  scalar / VO field maps via `domainToWire` on its (domain) type; a CONTAINMENT
 *  field's declared type is the `<Part>Response` name, so the mapper is built
 *  from the domain accessor with that name's `::from` directly — NOT via
 *  `domainToWire`, which would double-suffix (`LineResponseResponse::from`). */
function payloadFieldToWire(f: FieldIR, payloads: readonly PayloadIR[]): string {
  const t = eff(f.type, f.optional);
  const accessorExpr = `value.${f.name}()`;
  const base = t.kind === "array" ? t.element : t;
  if (base.kind === "entity" && isResponsePayloadName(payloads, base.name)) {
    if (t.kind === "array") return `${accessorExpr}.stream().map(${base.name}::from).toList()`;
    return `${accessorExpr} == null ? null : ${base.name}.from(${accessorExpr})`;
  }
  return domainToWire(t, accessorExpr);
}

/** `<Vo>Response` records for a set of value objects, emitted into `pkg` (so a
 *  read-model DTO / row in that package resolves the wire type in-package).  The
 *  seed `voNames` are closed over nested VOs (a VO field may itself be a VO) —
 *  the same fixpoint the aggregate DTO pass runs — then each is rendered.  Used
 *  wherever a read shape surfaces a VO outside an aggregate's own
 *  `application.<agg>` package (workflow-instance / projection reads →
 *  `application.workflows`, view rows → `application.views`). */
export function voResponseRecords(
  voNames: Iterable<string>,
  voLookup: ReadonlyMap<string, readonly FieldIR[]>,
  pkg: string,
  basePkg: string,
): DtoFile[] {
  const names = new Set(voNames);
  const queue = [...names];
  while (queue.length > 0) {
    const vo = queue.pop()!;
    const before = names.size;
    referencedValueObjects(
      (voLookup.get(vo) ?? []).map((f) => f.type),
      names,
    );
    if (names.size > before) {
      for (const v of names) if (!queue.includes(v)) queue.push(v);
    }
  }
  return [...names]
    .sort()
    .map((vo) => voRecord(vo, voLookup.get(vo) ?? [], "Response", pkg, basePkg));
}

/** `<Vo>Response` records for every value object surfaced on a read-model wire
 *  shape — workflow-instance views (`instanceWireShape`) and projection rows
 *  (`wireShape`).  These land in the shared `application.workflows` package
 *  (`pkg`), co-located with the `<Wf>InstanceResponse` / `<Proj>Response` DTOs
 *  that reference them and imported wildcard by the instance / projection
 *  controllers — so a VO-typed saga-state / read-model field resolves the same
 *  way an aggregate response does (a VO used only in saga/projection state,
 *  never on an aggregate response, has no record in any `application.<agg>`
 *  package, so it is emitted here rather than import-resolved).  Deduped by VO
 *  name across both read paths. */
export function renderReadModelVoResponseDtos(
  ctx: EnrichedBoundedContextIR,
  pkg: string,
  basePkg: string,
): DtoFile[] {
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  const voNames = new Set<string>();
  for (const wf of observableWorkflowsOf(ctx)) {
    referencedValueObjects(
      (wf.instanceWireShape ?? []).map((w) => w.type),
      voNames,
    );
  }
  for (const proj of ctx.projections) {
    referencedValueObjects(
      (proj.wireShape ?? []).map((w) => w.type),
      voNames,
    );
  }
  return voResponseRecords(voNames, voLookup, pkg, basePkg);
}

function accessor(w: WireField): string {
  return `${w.name}()`;
}
