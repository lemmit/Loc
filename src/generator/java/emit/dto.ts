import {
  emitsRestCreate,
  forApiRead,
  forCreateInput,
  isRequiredCreateInput,
  wireFieldsFor,
  wireFieldsForAggregate,
  wireFieldsForPart,
} from "../../../ir/enrich/wire-projection.js";
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
import { snake, upperFirst } from "../../../util/naming.js";
import { javaValueTypeForId, renderJavaExpr } from "../render-expr.js";
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

function isOptionalType(t: TypeIR): boolean {
  return t.kind === "optional";
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
  // A `File` component is the shared `FileRef` record in domain.common (M-T1.2)
  // — imported precisely (not wildcarded) so a File-free DTO stays byte-identical.
  const usesFileRef = components.some((c) => /\bFileRef\b/.test(c));
  return lines(
    `package ${pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    usesFileRef ? `import ${basePkg}.domain.common.FileRef;` : null,
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
  /** M-T2.6: the aggregate's implicit findAll is paged (plain relational) — emit
   *  a concrete `<Agg>Paged` envelope record the controller returns, so springdoc
   *  names + shapes the OpenAPI schema `<Agg>Paged` (matching every backend). */
  pagedAutoAll = false,
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
    wireFieldsForAggregate(agg).map((w) => w.type),
    voNames,
  );
  for (const part of agg.parts) {
    referencedValueObjects(
      wireFieldsForPart(part).map((w) => w.type),
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
      // Every OMITTABLE create input must be boxed, so an absent key
      // deserializes to null instead of 400ing, and the service materializes
      // the value (RS-6 / RST-10, parity with node/python).
      //
      // Driven by `isRequiredCreateInput` — the canonical rule — rather than
      // re-derived.  The re-derived form here was `f.optional || f.default !=
      // null`, which misses the third omittable arm: a BARE `bool`, whose
      // implicit `false` is a language-defined default with no `= expr` to
      // test for.  That left `boolean flag` primitive while this backend's own
      // `RequiredSet` listed the create request as requiring only `name`, so
      // Java advertised the field as omittable and then rejected the omission
      // — Jackson 3 (Spring Boot 4) enables FAIL_ON_NULL_FOR_PRIMITIVES, so a
      // missing primitive is a hard HttpMessageNotReadableException → 400
      // "Malformed request body", not the silent `false` Jackson 2 supplied.
      createInputs.map((f) => ({
        name: f.name,
        type: eff(f.type, !isRequiredCreateInput(f)),
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
      if (isOptionalType(p.type)) return `${wireJavaType(p.type, "Request")} ${p.name}`;
      // RS-26: an omitted operation param must be REJECTED, not silently
      // zero-valued.  A primitive component cannot express absence — Jackson
      // deserializes a missing `boolean active` to `false` and a missing
      // `int qty` to `0`, so a PUT that left out a field quietly overwrote
      // stored state, while this backend's own RequiredSet claimed the field
      // was required.  Boxing gives us a null to detect and `@NotNull` turns
      // it into the 400 the contract promises (`@Valid` is already on the
      // controller's @RequestBody).
      imports.add("jakarta.validation.constraints.NotNull");
      const boxed = eff(p.type, true);
      return `@NotNull ${wireJavaType(boxed, "Request")} ${p.name}`;
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

  // --- paged envelope (`<Agg>Paged`) ------------------------------------------------
  // A concrete record (not the generic `Paged<T>`) so springdoc names the
  // OpenAPI component `<Agg>Paged` and marks its record components required —
  // matching the Hono/.NET/Phoenix/Python paged schema exactly.
  if (pagedAutoAll) {
    out.push({
      name: `${agg.name}Paged.java`,
      category: "response-dto",
      content: recordFile(
        pkg,
        basePkg,
        `${agg.name}Paged`,
        [
          `List<${agg.name}Response> items`,
          "int page",
          "int pageSize",
          "int total",
          "int totalPages",
        ],
        [],
        new Set<string>(["java.util.List"]),
      ),
    });
  }

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
  const maskedArgs: string[] = [];
  let maskedAny = false;
  if (declared) {
    // The record omits `id` (grammar-reserved) — re-prepend it exactly as the
    // wireShape id row derives, so the leading component/mapper match.
    const idW = forApiRead(wireFieldsFor(entity)).find((w) => w.source === "id");
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
    const shape = forApiRead(wireFieldsFor(entity));
    for (const w of shape) {
      const masked = w.maskUnless !== undefined;
      // A `mask unless` field can be redacted to null on a RESPONSE (fail-closed),
      // so its component must admit null — force the boxed/nullable wire type even
      // when the field is declared non-optional (authorization.md §5).  The
      // component is shared by both mappers; `from` still projects the real value
      // (auto-boxed), only `fromMasked` may pass null.
      const t = masked ? eff(wireFieldType(w), true) : wireFieldType(w);
      collectWireImports(t, imports);
      components.push(`${wireJavaType(t, "Response")} ${w.name}`);
      const projected = domainToWire(t, `value.${accessor(w)}`);
      // `from` stays UNMASKED — internal audit before/after snapshots project
      // through it and must record the real value.
      args.push(projected);
      if (masked) {
        // `fromMasked` redacts unless the ambient principal satisfies the
        // predicate.  `__maskUser` is bound off the STATIC `CurrentUserAccessor
        // .currentOrNull()` (a static mapper injects no bean); an unauthenticated
        // request (`__maskUser == null`) always redacts.
        maskedAny = true;
        const pred = renderJavaExpr(w.maskUnless!, {
          thisName: "value",
          currentUserExpr: "__maskUser",
        });
        maskedArgs.push(`(__maskUser != null && (${pred})) ? ${projected} : null`);
      } else {
        maskedArgs.push(projected);
      }
    }
  }
  // Co-located provenance (provenance.md): each provenanced field appends a
  // trailing lineage component carrying the current lineage, so any GET
  // surfaces it inline (the field's own value still emits above).  Parts carry
  // no provenanced fields (write sites live on the root), so this is a no-op
  // for them — keeping non-provenance responses byte-identical.
  //
  // The WIRE KEY is `<field>_provenance`, NOT the camelCase component name.
  // That is the documented sibling key (provenance.md §"Scaffolded UI"), it is
  // what the other four backends emit, and it is what the SCAFFOLDED FRONTEND
  // reads (`data.total_provenance`, `_body-builders.ts`) — so a camelCase key
  // here silently blanks the provenance disclosure on every generated UI
  // pointed at a Java backend.  `@JsonProperty` renames the wire key without
  // giving the record an un-Java-like component name.  (RS-18.)
  for (const f of entity.fields.filter((pf) => pf.provenanced)) {
    imports.add(`${basePkg}.domain.common.ProvLineage`);
    imports.add("com.fasterxml.jackson.annotation.JsonProperty");
    components.push(
      `@JsonProperty(${JSON.stringify(`${snake(f.name)}_provenance`)}) ProvLineage ${f.name}Provenance`,
    );
    args.push(`value.${f.name}Provenance()`);
  }
  // A `mask unless` field redacts fail-closed on a RESPONSE via a SECOND mapper,
  // `fromMasked` — `from` stays unmasked for audit snapshots.  `fromMasked` binds
  // the ambient principal once off the STATIC accessor (a static mapper injects
  // no bean), then each masked arg guards on it (authorization.md §5).  The
  // imports + second method ride in only when a mask is present, so mask-free
  // records stay byte-identical.
  if (maskedAny) {
    imports.add(`${basePkg}.auth.CurrentUserAccessor`);
    imports.add(`${basePkg}.auth.User`);
  }
  const body = [
    `    public static ${recordName} from(${entity.name} value) {`,
    `        return new ${recordName}(${args.join(", ")});`,
    `    }`,
    ...(maskedAny
      ? [
          ``,
          `    /** Response projection with \`mask unless\` fields redacted to null`,
          `     *  unless the ambient principal satisfies each field's predicate`,
          `     *  (fail-closed — unauthenticated redacts). */`,
          `    public static ${recordName} fromMasked(${entity.name} value) {`,
          `        User __maskUser = CurrentUserAccessor.currentOrNull();`,
          `        return new ${recordName}(${maskedArgs.join(", ")});`,
          `    }`,
        ]
      : []),
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
 *  `application.workflows`, projection read rows → `application.views`). */
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
