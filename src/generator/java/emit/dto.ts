import { forApiRead, forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  ParamIR,
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

  // --- create request (constructible aggregates; event-sourced ones are
  // constructible through their `create` action's params) -------------------------
  const createInputs = forCreateInput(agg.fields);
  if (agg.canonicalCreate != null || esCreateParams) {
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
  out.push(wireRecord(agg, `${agg.name}Response`, pkg, basePkg, entityImport));

  // --- create response (`{ id }`) ---------------------------------------------------
  if (agg.canonicalCreate != null || esCreateParams) {
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
): DtoFile {
  const shape = forApiRead(entity.wireShape ?? []);
  const imports = new Set<string>();
  const components = shape.map((w) => {
    const t = wireFieldType(w);
    collectWireImports(t, imports);
    return `${wireJavaType(t, "Response")} ${w.name}`;
  });
  const args = shape.map((w) => domainToWire(wireFieldType(w), `value.${accessor(w)}`));
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
