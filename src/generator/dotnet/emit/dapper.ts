// ---------------------------------------------------------------------------
// dapper — minimal-real persistence emitters for the .NET backend
// (D-REALIZATION-AXES).  An ALTERNATE persistence implementation
// selected by `persistence: dapper`: the generated Domain layer (entities, ids,
// value objects, enums, events, commands/handlers/controllers) is
// persistence-agnostic and reused as-is; Dapper only replaces the Infrastructure
// (per-aggregate repository + Npgsql connection + a self-applied `schema.sql`),
// the Program.cs persistence wiring, and the project deps.
//
// SCOPE (v1, validator-gated in `ir/validate/validate.ts`): relational shape,
// flat aggregates whose fields are scalar / enum / value-object / single id-ref.
// Everything else (document/embedded shape, associations, nested parts,
// inheritance, event-sourcing, audit/provenance/managed fields) is rejected at
// validate time, so this emitter only ever sees the supported subset.
//
// Hydration seam: the entity exposes `<Agg>._Create(new <Agg>.State { … })`, so a
// queried row maps cleanly into the domain object without EF.  Value objects are
// stored as a single `jsonb` column (System.Text.Json round-trip); enums as
// `text` (`.ToString()` / `Enum.Parse`).
// ---------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  ContainmentIR,
  EnrichedAggregateIR,
  EntityPartIR,
  ExprIR,
  FieldIR,
  IdValueType,
  ParamIR,
  RepositoryIR,
  RetrievalIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import type { TableShape } from "../../../ir/types/migrations-ir.js";
import { aggHasAuditedTarget } from "../../../ir/util/audit-capability.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import { refCollectionFieldName } from "../../../ir/util/ref-collection.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { isDenyFilter } from "../../../ir/util/tenant-stance.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { intrinsicFor, intrinsicKey } from "../../../util/intrinsics.js";
import { escapeCsharpIdent, plural, snake, upperFirst } from "../../../util/naming.js";
import { PG_INTRINSIC_SQL } from "../../_expr/pg-intrinsics.js";
import { renderCreateTableIfNotExists } from "../../sql-pg.js";
import { isReservedIdent } from "../../sql-reserved.js";
import { unionFindAsOptionalTwin } from "../find-emit.js";
import {
  AMBIENT_CURRENT_USER,
  csValueTypeForId,
  renderCsExpr,
  renderCsType,
} from "../render-expr.js";
import { renderRetrievalParamsWithCt } from "./repository.js";

// ---------------------------------------------------------------------------
// Reserved-word identifier quoting (M-T6.42).
//
// This adapter writes its own SQL, so every table / column name it emits is a
// BARE identifier — and a `.ddd` field named `order` / `group` / `limit` /
// `end` is a Postgres RESERVED word, which makes both the emitted DDL and every
// statement that names the column a syntax error:
//
//     CREATE TABLE tickets (order integer not null, …)
//     SELECT id, order, group FROM tickets WHERE id = @id
//
// The migrations path settled this question the other way long ago —
// `sql-pg.ts` quotes ALWAYS, "safe for reserved words (`order`, `user`,
// `end`)" — but this adapter provisions its own schema (`hasMigrations =
// !usingDapper`, DbSchema.EnsureAsync) and never picked the rule up.
//
// The WORD LIST is not ours: it lives once in `src/generator/sql-reserved.ts`,
// shared with the Java backend's Hibernate quoting (M-T6.43).  Only the
// ESCAPING is per-backend, and here it is per-CONTEXT, which is what made a
// partial fix worse than none (#2559 reverted one for exactly this reason):
//
//   - `new CommandDefinition("SELECT …")` — a REGULAR literal, needs `\"`.
//   - `DbSchema.cs`'s `public const string Sql = @"…"` — a VERBATIM literal,
//     where `\` is not an escape and a quote is written `""`.
//
// There are ~47 of the first and exactly ONE of the second, so `sqlIdent`
// emits the regular-literal form and the single verbatim funnel translates on
// the way in (`ddlToVerbatimLiteral`).  That way no call site has to know
// which context it is in — the one that does is the one that can be read in
// full.
// ---------------------------------------------------------------------------

/** One identifier in SQL position (a table or column name), quoted when it is a
 *  Postgres reserved word.  The quotes are written for a C# REGULAR string
 *  literal (`\"order\"`) — see the header: that is the context ~47 of the 48
 *  emission sites are in, and the one exception translates centrally.
 *
 *  NOT for Dapper parameter names (`@order` is a parameter, not an identifier),
 *  nor for the C# row-DTO property names, nor for derived names an identifier
 *  only seeds (an index name) — all three take the bare `col`. */
export function sqlIdent(name: string): string {
  return isReservedIdent(name) ? `\\"${name}\\"` : name;
}

/** Re-encode a DDL fragment for `DbSchema.cs`'s VERBATIM (`@"…"`) literal.
 *
 *  The fragments arrive carrying `sqlIdent`'s regular-literal escaping
 *  (`\"order\"`), because that is what every other emission site needs.  In a
 *  verbatim literal a backslash is just a backslash and a quote is doubled, so
 *  strip the escape and double what is left.  Also doubles any quote the DDL
 *  carried for other reasons, which is what this funnel always did. */
function ddlToVerbatimLiteral(ddl: string): string {
  return ddl.replace(/\\"/g, '"').replace(/"/g, '""');
}

/** Postgres table for an aggregate — lowercase plural (e.g. `orders`).  BARE:
 *  callers quote it at the SQL position with `sqlIdent`, because the same
 *  string also seeds derived names (a `CREATE INDEX` name) where a quote would
 *  be wrong. */
const tableOf = (aggName: string): string => plural(snake(aggName));

/** The state table an aggregate's rows live in — the SAME derivation the
 *  repositories and the DDL use, exported so the OTHER raw-Npgsql readers
 *  (the query-time projection handlers, which query the table directly rather
 *  than through a repository) name the identical table.  Pass the TPH BASE
 *  name for a `sharedTable` concrete: it has no table of its own. */
export function dapperAggregateTable(aggName: string): string {
  return tableOf(aggName);
}

/** SQL + C# row type for an id value type. */
export function idTypes(vt: IdValueType): { sql: string; cs: string } {
  switch (vt) {
    case "int":
      return { sql: "integer", cs: "int" };
    case "long":
      return { sql: "bigint", cs: "long" };
    case "string":
      return { sql: "text", cs: "string" };
    default:
      return { sql: "uuid", cs: "Guid" };
  }
}

/** SQL + C# row type for a primitive. */
function primTypes(name: string): { sql: string; cs: string } {
  switch (name) {
    case "int":
      return { sql: "integer", cs: "int" };
    case "long":
      return { sql: "bigint", cs: "long" };
    case "decimal":
    case "money":
      return { sql: "numeric", cs: "decimal" };
    case "bool":
      return { sql: "boolean", cs: "bool" };
    case "datetime":
      return { sql: "timestamptz", cs: "DateTime" };
    case "guid":
      return { sql: "uuid", cs: "Guid" };
    case "json":
      return { sql: "jsonb", cs: "string" };
    case "File":
      // A `File` field's FileRef persists as jsonb (M-T1.2); the row DTO
      // carries the raw JSON string (fieldColumn serializes FileRef ⇄ string).
      return { sql: "jsonb", cs: "string" };
    default:
      return { sql: "text", cs: "string" };
  }
}

/** A persisted column + the C# expressions that read it off the aggregate
 *  (save) and reconstruct it into the `State` (hydrate). */
export interface DapperColumn {
  col: string; // snake_case column name (== Dapper param + Row prop)
  sql: string; // Postgres column type
  nullable: boolean;
  rowCs: string; // C# type on the row DTO
  /** placeholder cast in the INSERT VALUES list (`""` or `"::jsonb"`). */
  cast: string;
  /** C# expression reading the save value off `aggregate`. */
  save: string;
  /** State init property (PascalCase). */
  stateProp: string;
  /** C# expression building the State value from `r.<col>`. */
  hydrate: string;
}

function unwrapOptional(t: TypeIR): { type: TypeIR; nullable: boolean } {
  return t.kind === "optional" ? { type: t.inner, nullable: true } : { type: t, nullable: false };
}

/** The id column — every aggregate has one.  `idClass` names the strongly-typed
 *  id struct the hydrate mints; it defaults to `<Agg>Id` but a TPH concrete
 *  passes its shared base's `<Base>Id` (the concrete declares no id of its own). */
function idColumn(agg: EnrichedAggregateIR, idClass = `${agg.name}Id`): DapperColumn {
  const { sql, cs } = idTypes(agg.idValueType);
  return {
    col: "id",
    sql,
    nullable: false,
    rowCs: cs,
    cast: "",
    save: "aggregate.Id.Value",
    stateProp: "Id",
    hydrate: `new ${idClass}(r.id)`,
  };
}

/** Map a supported field to its column.  Throws on an unsupported field kind —
 *  the validator gates these out, so reaching the throw means a gating gap.
 *  `accBase` is the C# object the SAVE expression reads off (`aggregate` for a
 *  root field, the per-child loop variable for a contained part's field). */
export function fieldColumn(f: FieldIR, accBase = "aggregate"): DapperColumn {
  const { type, nullable } = unwrapOptional(f.type);
  const col = snake(f.name);
  const prop = upperFirst(f.name);
  const acc = `${accBase}.${prop}`;
  switch (type.kind) {
    case "primitive": {
      if (type.name === "File") {
        // A `File` field's FileRef persists as jsonb via System.Text.Json —
        // structurally the value-object arm, but the CLR type is `FileRef`.
        return {
          col,
          sql: "jsonb",
          nullable,
          rowCs: nullable ? "string?" : "string",
          cast: "::jsonb",
          save: nullable
            ? `${acc} is null ? null : System.Text.Json.JsonSerializer.Serialize(${acc})`
            : `System.Text.Json.JsonSerializer.Serialize(${acc})`,
          stateProp: prop,
          hydrate: nullable
            ? `r.${escapeCsharpIdent(col)} is null ? (FileRef?)null : System.Text.Json.JsonSerializer.Deserialize<FileRef>(r.${escapeCsharpIdent(col)})!`
            : `System.Text.Json.JsonSerializer.Deserialize<FileRef>(r.${escapeCsharpIdent(col)})!`,
        };
      }
      const { sql, cs } = primTypes(type.name);
      return {
        col,
        sql,
        nullable,
        rowCs: `${cs}${nullable ? "?" : ""}`,
        cast: "",
        save: acc,
        stateProp: prop,
        hydrate: `r.${escapeCsharpIdent(col)}`,
      };
    }
    case "enum":
      return {
        col,
        sql: "text",
        nullable,
        rowCs: nullable ? "string?" : "string",
        cast: "",
        save: nullable ? `${acc}?.ToString()` : `${acc}.ToString()`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${escapeCsharpIdent(col)} is null ? (${type.name}?)null : Enum.Parse<${type.name}>(r.${escapeCsharpIdent(col)})`
          : `Enum.Parse<${type.name}>(r.${escapeCsharpIdent(col)})`,
      };
    case "valueobject":
      return {
        col,
        sql: "jsonb",
        nullable,
        rowCs: nullable ? "string?" : "string",
        cast: "::jsonb",
        save: nullable
          ? `${acc} is null ? null : System.Text.Json.JsonSerializer.Serialize(${acc})`
          : `System.Text.Json.JsonSerializer.Serialize(${acc})`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${escapeCsharpIdent(col)} is null ? (${type.name}?)null : System.Text.Json.JsonSerializer.Deserialize<${type.name}>(r.${escapeCsharpIdent(col)})!`
          : `System.Text.Json.JsonSerializer.Deserialize<${type.name}>(r.${escapeCsharpIdent(col)})!`,
      };
    case "id": {
      const { sql, cs } = idTypes(type.valueType);
      return {
        col,
        sql,
        nullable,
        rowCs: `${cs}${nullable ? "?" : ""}`,
        cast: "",
        save: nullable ? `${acc}?.Value` : `${acc}.Value`,
        stateProp: prop,
        hydrate: nullable
          ? `r.${escapeCsharpIdent(col)} is null ? (${type.targetName}Id?)null : new ${type.targetName}Id(r.${escapeCsharpIdent(col)}${cs === "Guid" ? ".Value" : ""})`
          : `new ${type.targetName}Id(r.${escapeCsharpIdent(col)})`,
      };
    }
    case "array": {
      // A scalar/enum/value-object collection field (`tags: string[]`,
      // `stops: Money[]`) — stored as ONE `jsonb` column holding the serialised
      // list, the raw-Npgsql mirror of EF's primitive-collection / owned-array
      // JSON mapping.  The whole `List<T>` round-trips through System.Text.Json
      // (enums as numbers, VOs as objects — internal to the column, so the wire
      // shape still comes from the domain object).  Nullable (`string[]?`)
      // stores JSON `null`.
      const elemCs = arrayElemCs(type.element);
      const listCs = `List<${elemCs}>`;
      return {
        col,
        sql: "jsonb",
        nullable,
        rowCs: nullable ? "string?" : "string",
        cast: "::jsonb",
        save: nullable
          ? `${acc} is null ? null : System.Text.Json.JsonSerializer.Serialize(${acc})`
          : `System.Text.Json.JsonSerializer.Serialize(${acc})`,
        stateProp: prop,
        // An ABSENT collection hydrates to an EMPTY list, not null (RS-8): the
        // wire contract for a collection is `[]`, never `null`, so a client can
        // iterate without a guard.  The EF adapter gets this for free — an
        // `OwnsMany` child table materializes an empty collection — but Dapper
        // stores the column as jsonb and faithfully round-trips SQL NULL, which
        // reached the wire as `null` on this adapter alone.  Coalescing on the
        // READ (not the write) also repairs rows already written as NULL.
        hydrate: nullable
          ? `r.${escapeCsharpIdent(col)} is null ? new ${listCs}() : System.Text.Json.JsonSerializer.Deserialize<${listCs}>(r.${escapeCsharpIdent(col)})!`
          : `System.Text.Json.JsonSerializer.Deserialize<${listCs}>(r.${escapeCsharpIdent(col)})!`,
      };
    }
    default:
      throw new Error(
        `dapper: unsupported field kind '${type.kind}' on '${f.name}' (validator gap)`,
      );
  }
}

/** The C# element type for a collection field's element (used to type the
 *  `List<T>` a jsonb array column round-trips).  Mirrors the scalar arms of
 *  `fieldColumn`: primitive → its C# type, enum / value-object → the declared
 *  type name, id → the strongly-typed `<Target>Id`. */
function arrayElemCs(elem: TypeIR): string {
  switch (elem.kind) {
    case "primitive":
      return primTypes(elem.name).cs;
    case "enum":
    case "valueobject":
      return elem.name;
    case "id":
      return `${elem.targetName}Id`;
    default:
      throw new Error(`dapper: unsupported array element kind '${elem.kind}' (validator gap)`);
  }
}

/** Co-located provenance lineage column (`<field>_provenance` jsonb) for a
 *  `provenanced` root field — the current ProvLineage, round-tripped through
 *  System.Text.Json (ProvJson.Options) exactly like the EF value-converter, so
 *  the read DTO's `<Field>Provenance` projection is populated on both adapters. */
function provColumn(f: FieldIR): DapperColumn {
  const col = `${snake(f.name)}_provenance`;
  const prop = `${upperFirst(f.name)}Provenance`;
  return {
    col,
    sql: "jsonb",
    nullable: true,
    rowCs: "string?",
    cast: "::jsonb",
    save: `aggregate.${prop} is null ? null : System.Text.Json.JsonSerializer.Serialize(aggregate.${prop}, ProvJson.Options)`,
    stateProp: prop,
    hydrate: `r.${escapeCsharpIdent(col)} is null ? null : System.Text.Json.JsonSerializer.Deserialize<ProvLineage>(r.${escapeCsharpIdent(col)}, ProvJson.Options)`,
  };
}

/** Embedded (`shape: embedded`) containment column — one JSONB column per
 *  containment holding the serialised part snapshot(s).  The whole contained
 *  sub-graph folds into this one column (no child table): a collection stores a
 *  JSON array of snapshots, a single (optional) containment stores one snapshot
 *  (or null).  Round-trips through the part's persistence-agnostic
 *  `ToSnapshot()` / `FromSnapshot(...)` (emitted under the entity `document`
 *  seam), the raw-Npgsql mirror of EF's owned-type `.ToJson()` mapping.  Save
 *  reads off `aggregate`, hydrate off the flat `Row` (`r.<col>`) into the
 *  `_Create(State)` containment slot. */
function embeddedContainmentColumn(cont: ContainmentIR): DapperColumn {
  const col = snake(cont.name);
  const prop = upperFirst(cont.name);
  const snapT = `${cont.partName}Snapshot`;
  if (cont.collection) {
    return {
      col,
      sql: "jsonb",
      nullable: false,
      rowCs: "string",
      cast: "::jsonb",
      save: `System.Text.Json.JsonSerializer.Serialize(aggregate.${prop}.Select(__x => __x.ToSnapshot()).ToList(), __json)`,
      stateProp: prop,
      hydrate: `System.Text.Json.JsonSerializer.Deserialize<List<${snapT}>>(r.${escapeCsharpIdent(col)}, __json)!.Select(${cont.partName}.FromSnapshot).ToList()`,
    };
  }
  if (cont.optional) {
    return {
      col,
      sql: "jsonb",
      nullable: true,
      rowCs: "string?",
      cast: "::jsonb",
      save: `aggregate.${prop} is null ? null : System.Text.Json.JsonSerializer.Serialize(aggregate.${prop}.ToSnapshot(), __json)`,
      stateProp: prop,
      hydrate: `r.${escapeCsharpIdent(col)} is null ? null : ${cont.partName}.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<${snapT}>(r.${escapeCsharpIdent(col)}, __json)!)`,
    };
  }
  return {
    col,
    sql: "jsonb",
    nullable: false,
    rowCs: "string",
    cast: "::jsonb",
    save: `System.Text.Json.JsonSerializer.Serialize(aggregate.${prop}.ToSnapshot(), __json)`,
    stateProp: prop,
    hydrate: `${cont.partName}.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<${snapT}>(r.${escapeCsharpIdent(col)}, __json)!)`,
  };
}

function columnsOf(
  agg: EnrichedAggregateIR,
  embedded = false,
  idClass = `${agg.name}Id`,
): DapperColumn[] {
  // Reference-collection fields (`X id[]`) live in their join tables, not as
  // root columns — see the association load/save blocks in the repository.
  const assocFields = new Set((agg.associations ?? []).map((a) => a.fieldName));
  return [
    idColumn(agg, idClass),
    ...agg.fields.filter((f) => !assocFields.has(f.name)).map((f) => fieldColumn(f)),
    // One co-located `<field>_provenance` lineage column per provenanced field.
    ...agg.fields.filter((f) => f.provenanced).map(provColumn),
    // shape: embedded: each containment folds into one JSONB column (no child
    // table).  Relational (default) keeps them as child tables (partChildrenOf).
    ...(embedded ? (agg.contains ?? []).map(embeddedContainmentColumn) : []),
  ];
}

// ---------------------------------------------------------------------------
// Nested entity parts (`contains lineItems: LineItem[]`).  Each root-level
// containment persists as one FLAT child table (`id` PK + `<agg>_id` FK + the
// part's scalar/enum/vo/id columns), bulk-loaded on every read and hydrated
// through the root's `_Create(State)` seam, full-list-replaced on save, and
// cascade-deleted.  Part-in-part, part reference collections, and containments
// on event-sourced aggregates stay validator-gated (v1 scope).
// ---------------------------------------------------------------------------

interface PartChild {
  cont: ContainmentIR;
  part: EntityPartIR;
  /** Child table (`line_items`). */
  table: string;
  /** The entity whose table this part's row FKs to — the aggregate root (or, for
   *  a TPH concrete, the shared base) for a root-level part, a sibling part for
   *  a nested (part-in-part) one.  Drives the `<fkOwner>_id` column + the schema
   *  `references plural(fkOwner)`. */
  fkOwner: string;
  parentFk: string;
  /** The entity type the part's `State.ParentId` is typed to — the entity's
   *  `parentName` (`directParentName`): the CONCRETE aggregate for a TPH
   *  concrete's root-level part (whose FK still targets the base table), the
   *  sibling part for a nested one.  Off the TPH path this equals `fkOwner`. */
  parentEntityId: string;
  /** C# / SQL types for the owner FK and the part's own `id`. */
  parentIdCs: string;
  partIdCs: string;
  parentIdSql: string;
  partIdSql: string;
  /** The per-child loop variable the SAVE block reads off — unique per
   *  containment so two save blocks in the one `SaveAsync` don't collide
   *  (`__lineItemsChild`, `__shippingChild`). */
  childVar: string;
  /** The part's field columns (save expressions read off `childVar`; hydrate
   *  expressions read off the child `r` row). */
  fieldCols: DapperColumn[];
  /** Nested part-in-part containments — this part's own `contains`, each a
   *  grandchild table FK'd to THIS part's row (recursion). */
  children: PartChild[];
}

/** Build the containment tree for `agg`.  `ownerName` is the entity that owns
 *  the physical root table the top-level parts FK to — `agg.name` for a plain
 *  aggregate, the shared TPH base for a TPH concrete (so a concrete's contained
 *  parts hang off the base row, EF's TPT-via-contains).  Recurses into each
 *  part's own `contains`, FK'ing a grandchild to its DIRECT parent part. */
function partChildrenOf(agg: EnrichedAggregateIR, ownerName: string = agg.name): PartChild[] {
  const buildLevel = (
    containments: readonly ContainmentIR[],
    fkOwner: string,
    fkOwnerIdVt: IdValueType,
    parentEntityId: string,
  ): PartChild[] =>
    containments.map((cont): PartChild => {
      const part = (agg.parts ?? []).find((p) => p.name === cont.partName)!;
      const childVar = `__${cont.name}Child`;
      return {
        cont,
        part,
        table: plural(snake(part.name)),
        fkOwner,
        parentFk: `${snake(fkOwner)}_id`,
        parentEntityId,
        parentIdCs: idTypes(fkOwnerIdVt).cs,
        partIdCs: idTypes(part.parentIdValueType).cs,
        parentIdSql: idTypes(fkOwnerIdVt).sql,
        partIdSql: idTypes(part.parentIdValueType).sql,
        childVar,
        fieldCols: part.fields.map((f) => fieldColumn(f, childVar)),
        // A nested part FKs its DIRECT parent (this part), for both the storage
        // FK and the `State.ParentId` type — so `fkOwner === parentEntityId`
        // below (the TPH split only ever applies at the root level).
        children: buildLevel(part.contains ?? [], part.name, part.parentIdValueType, part.name),
      };
    });
  return buildLevel(agg.contains ?? [], ownerName, agg.idValueType, agg.name);
}

/** Flatten the containment tree to every part table (pre-order) — the schema,
 *  save, and delete passes that need one row per table walk this. */
function flattenParts(children: readonly PartChild[]): PartChild[] {
  return children.flatMap((pc) => [pc, ...flattenParts(pc.children)]);
}

/** A `{ upperFirst(cont) } = <dict>.TryGetValue(<key>, out var …) ? … : <empty>`
 *  containment slot, shared by the root `_Create` and each part `Map`.  `indent`
 *  and `keyExpr` differ per site (12 spaces + `r.id` in a part Map; 16 spaces +
 *  `r.id` in the root reconstruction). */
function containmentSlot(pc: PartChild, indent: string, keyExpr: string): string {
  const byOwner = `__${pc.cont.name}ByOwner`;
  const local = `__${pc.cont.name}`;
  const head = `${indent}${upperFirst(pc.cont.name)} = ${byOwner}.TryGetValue(${keyExpr}, out var ${local}) ? ${local}`;
  return pc.cont.collection ? `${head} : new List<${pc.part.name}>(),` : `${head} : null,`;
}

/** The C# dictionary value type a containment groups its children into —
 *  `IReadOnlyList<Part>` for a collection, `Part` for a single. */
function containmentValueType(pc: PartChild): string {
  return pc.cont.collection ? `IReadOnlyList<${pc.part.name}>` : pc.part.name;
}

/** Row DTO + `Map<Part>` static for one part.  A part that itself contains
 *  nested parts takes each grandchild's grouped dictionary as an extra
 *  parameter and slots them into its `State`, so a whole part-in-part subtree
 *  reconstructs bottom-up.  A leaf part keeps the parameterless `Map<Part>(Row)`
 *  shape (byte-identical to the pre-recursion single-level output). */
function partRowAndMap(pc: PartChild): string {
  const rowCols = [
    `        public ${pc.partIdCs} id { get; set; }`,
    `        public ${pc.parentIdCs} ${escapeCsharpIdent(pc.parentFk)} { get; set; }`,
    ...pc.fieldCols.map(
      (c) =>
        `        public ${c.rowCs} ${escapeCsharpIdent(c.col)} { get; set; }${c.rowCs === "string" ? " = default!;" : ""}`,
    ),
  ];
  // The grandchild dictionaries are the concrete `Dictionary<…>` that
  // `ToDictionary` returns — declared as such (not `IReadOnlyDictionary`) so the
  // `/warnaserror` CA1859 "use the concrete type" analyzer stays quiet.
  const dictParams = pc.children.map(
    (gc) => `, Dictionary<${gc.parentIdCs}, ${containmentValueType(gc)}> __${gc.cont.name}ByOwner`,
  );
  const childSlots = pc.children.map((gc) => containmentSlot(gc, "            ", "r.id"));
  return lines(
    `    private sealed class ${pc.part.name}Row`,
    "    {",
    ...rowCols,
    "    }",
    "",
    `    private static ${pc.part.name} Map${pc.part.name}(${pc.part.name}Row r${dictParams.join("")}) =>`,
    `        ${pc.part.name}._Create(new ${pc.part.name}.State`,
    "        {",
    `            Id = new ${pc.part.name}Id(r.id),`,
    `            ParentId = new ${pc.parentEntityId}Id(r.${escapeCsharpIdent(pc.parentFk)}),`,
    ...pc.fieldCols.map((c) => `            ${c.stateProp} = ${c.hydrate},`),
    ...childSlots,
    "        });",
  );
}

/** Load + group a containment subtree.  Returns the top-down `loads` (each
 *  level's rows filtered by its parent's ids) and the bottom-up `dicts` (each
 *  level's `GroupBy → ToDictionary`, children first so a parent's `Map` call can
 *  reference the grandchild dictionaries).  A leaf subtree yields
 *  `[rowsQuery]` / `[dict]`, whose concatenation reproduces the pre-recursion
 *  single-level output exactly. */
function hydrateSubtree(pc: PartChild, parentIdsVar: string): { loads: string[]; dicts: string[] } {
  const cols = ["id", sqlIdent(pc.parentFk), ...pc.fieldCols.map((c) => sqlIdent(c.col))].join(
    ", ",
  );
  const rowsVar = `__${pc.cont.name}Rows`;
  const byOwner = `__${pc.cont.name}ByOwner`;
  const idsVar = `__${pc.cont.name}Ids`;
  const loads: string[] = [
    `        var ${rowsVar} = (await conn.QueryAsync<${pc.part.name}Row>(new CommandDefinition("SELECT ${cols} FROM ${sqlIdent(pc.table)} WHERE ${sqlIdent(pc.parentFk)} = ANY(@ids) ORDER BY ${sqlIdent(pc.parentFk)}, id", new { ids = ${parentIdsVar} }, cancellationToken: cancellationToken))).ToList();`,
  ];
  const childDicts: string[] = [];
  if (pc.children.length > 0) {
    loads.push(`        var ${idsVar} = ${rowsVar}.Select(x => x.id).ToArray();`);
    for (const gc of pc.children) {
      const sub = hydrateSubtree(gc, idsVar);
      loads.push(...sub.loads);
      childDicts.push(...sub.dicts);
    }
  }
  // A leaf part maps via the method group (`g.Select(MapPart)`); a part with
  // children passes the grandchild dictionaries into each `Map` call.
  const mapArgs = pc.children.map((gc) => `, __${gc.cont.name}ByOwner`).join("");
  const collectSelect =
    pc.children.length === 0
      ? `g.Select(Map${pc.part.name})`
      : `g.Select(x => Map${pc.part.name}(x${mapArgs}))`;
  const dictLine = pc.cont.collection
    ? `        var ${byOwner} = ${rowsVar}.GroupBy(x => x.${pc.parentFk}).ToDictionary(g => g.Key, g => (IReadOnlyList<${pc.part.name}>)${collectSelect}.ToList());`
    : `        var ${byOwner} = ${rowsVar}.GroupBy(x => x.${pc.parentFk}).ToDictionary(g => g.Key, g => Map${pc.part.name}(g.First()${mapArgs}));`;
  return { loads, dicts: [...childDicts, dictLine] };
}

/** Per-part Row DTOs + `Map<Part>` statics (every part in the tree), plus the
 *  private `HydrateAsync` that bulk-loads every containment level for a page of
 *  root rows and reconstructs each root through `_Create(State)` with its
 *  (recursively nested) children in place. */
function containmentMembers(
  agg: EnrichedAggregateIR,
  children: PartChild[],
  idClass = `${agg.name}Id`,
): string[] {
  // The root's `State.Id` hydrate mints the SHARED base id class for a TPH
  // concrete (`idClass`), matching the concrete's `State.Id : <Base>Id`.
  const rootStateBody = columnsOf(agg, false, idClass).map(
    (c) => `                ${c.stateProp} = ${c.hydrate},`,
  );
  const rowClasses = flattenParts(children).map(partRowAndMap);
  // Per root-level child: its full subtree loads (top-down) then dicts
  // (bottom-up).  For a flat child this is `[rowsQuery, dict]` — the exact
  // interleaving the pre-recursion emitter produced.
  const loadBlocks = children.flatMap((pc) => {
    const sub = hydrateSubtree(pc, "__ids");
    return [...sub.loads, ...sub.dicts];
  });
  const slotLines = children.map((pc) => containmentSlot(pc, "                ", "r.id"));
  return [
    ...rowClasses.flatMap((m) => [m, ""]),
    `    private static async Task<List<${agg.name}>> HydrateAsync(NpgsqlConnection conn, List<Row> rows, CancellationToken cancellationToken)`,
    "    {",
    `        if (rows.Count == 0) return new List<${agg.name}>();`,
    "        var __ids = rows.Select(r => r.id).ToArray();",
    ...loadBlocks,
    `        return rows.Select(r => ${agg.name}._Create(new ${agg.name}.State`,
    "            {",
    ...rootStateBody,
    ...slotLines,
    "            })).ToList();",
    "    }",
  ];
}

// ---------------------------------------------------------------------------
// find `where` → SQL.  Minimal subset; throws on anything unsupported so the
// caller can emit a compile-safe `NotImplementedException` body.
// ---------------------------------------------------------------------------

const SQL_BINOP: Record<string, string> = {
  "==": "=",
  "!=": "<>",
  "<": "<",
  ">": ">",
  "<=": "<=",
  ">=": ">=",
  "&&": "AND",
  "||": "OR",
};

// Raw-Postgres scalar-intrinsic snippets come from the shared
// `PG_INTRINSIC_SQL` table (`src/generator/_expr/pg-intrinsics.ts`), which this
// adapter shares with Java's `@SQLRestriction` renderer — the other emitter that
// writes a filter predicate as SQL TEXT.  The EF Core sibling adapter needs no
// table at all (its where-path feeds the same C# expression to EF, which
// translates it), but Dapper writes the SQL itself, so every `queryable`
// catalogue row needs a snippet or `whereToSql` throws.
//
// It threw for ALL of them until M-T3.6: `whereToSql` had no intrinsic arm at
// all, while `DAPPER_SUBSET` (`src/ir/util/find-predicate-capability.ts`)
// declared this adapter fully-lowerable — so `criterion C of X = this.s.trim()
// == "a"` + `filter C` under `persistence: dapper` died at generate time with a
// bare `Error`, never a `loom.*` diagnostic.  Same shape as the `policy { deny }`
// crash of #2492.  The fix is the table, not a narrowing of the descriptor:
// every one of these IS expressible in Postgres SQL.

/** Optional context threaded into `whereToSql` so a
 *  `this.<refColl>.contains(x)` membership predicate can resolve its
 *  AssociationIR and correlate the EXISTS subquery on the owner table's
 *  `id`.  Absent for callers with no reference collections (byte-identical). */
export interface WhereSqlCtx {
  agg: EnrichedAggregateIR;
  table: string;
}

export function whereToSql(e: ExprIR, sqlCtx?: WhereSqlCtx): string {
  switch (e.kind) {
    case "paren":
      return `(${whereToSql(e.inner, sqlCtx)})`;
    case "unary":
      if (e.op === "!") return `(NOT ${whereToSql(e.operand, sqlCtx)})`;
      throw new Error("dapper: unsupported unary in find");
    case "binary": {
      const op = SQL_BINOP[e.op];
      if (!op) throw new Error(`dapper: unsupported operator '${e.op}' in find`);
      return `(${whereToSql(e.left, sqlCtx)} ${op} ${whereToSql(e.right, sqlCtx)})`;
    }
    case "method-call": {
      // `this.<refColl>.contains(x)` → EXISTS join subquery, the raw-SQL
      // mirror of EF's `_db.<JoinDbSet>.Any(__j => __j.owner == x.Id && …)`.
      // Detection is structural (receiverType `array<id>`, `this.<field>`
      // receiver resolving to an AssociationIR) so a regular collection
      // `.contains` never reaches here — those aren't queryable predicates.
      if (
        e.member === "contains" &&
        e.receiverType.kind === "array" &&
        e.receiverType.element.kind === "id" &&
        e.args.length === 1 &&
        sqlCtx
      ) {
        const fieldName = refCollectionFieldName(e.receiver);
        const assoc = fieldName
          ? sqlCtx.agg.associations.find((a) => a.fieldName === fieldName)
          : undefined;
        if (assoc) {
          const arg = whereToSql(e.args[0]!, sqlCtx);
          return (
            `EXISTS (SELECT 1 FROM ${sqlIdent(assoc.joinTable)} __j ` +
            `WHERE __j.${sqlIdent(assoc.ownerFk)} = ${sqlCtx.table}.id AND __j.${sqlIdent(assoc.targetFk)} = ${arg})`
          );
        }
      }
      // Queryable scalar intrinsic (src/util/intrinsics.ts) — `this.s.trim()`,
      // `this.dataKey.startsWith(p)`, `this.total.abs()`, …  Keyed off the
      // catalogue's `queryable` flag exactly like the four sibling SQL tables,
      // so a new queryable row is a completeness-test failure here rather than
      // a generate-time crash on this adapter.
      if (e.receiverType.kind === "primitive") {
        const key = intrinsicKey(e.receiverType.name, e.member);
        const snippet = intrinsicFor(e.receiverType.name, e.member)?.queryable
          ? PG_INTRINSIC_SQL[key]
          : undefined;
        if (snippet) {
          return snippet(
            whereToSql(e.receiver, sqlCtx),
            e.args.map((a) => whereToSql(a, sqlCtx)),
          );
        }
      }
      throw new Error(`dapper: unsupported method-call '${e.member}' in find`);
    }
    case "member":
      // `this.<field>` → column.
      if (e.receiver.kind === "this") return sqlIdent(snake(e.member));
      // `currentUser.<claim>` → a Dapper named parameter bound from the ambient
      // request principal (`RequestContext.Current!.CurrentUser!.<Claim>`).  The
      // caller (a capability `filter`) binds `@__cu_<claim>` into every SELECT's
      // parameter object — see `filterPrincipalRefs` in renderDapperRepository.
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user")
        return `@${currentUserParam(e.member)}`;
      throw new Error("dapper: unsupported member access in find");
    case "ref":
      // A find/retrieval parameter → Dapper named parameter.
      if (e.refKind === "param") return `@${e.name}`;
      // A candidate field (criterion / retrieval `where`) → its column.
      if (e.refKind === "this-prop") return sqlIdent(snake(e.name));
      // An enum value (`Status.Confirmed`) → its text representation, matching
      // the `text` column the enum is stored as.
      if (e.refKind === "enum-value") return `'${e.name.replace(/'/g, "''")}'`;
      throw new Error(`dapper: unsupported ref '${e.refKind}' in find`);
    case "authz-filter":
      return authzFilterToSql(e);
    case "literal":
      switch (e.lit) {
        case "string":
          return `'${e.value.replace(/'/g, "''")}'`;
        case "bool":
          return e.value === "true" ? "TRUE" : "FALSE";
        case "null":
          return "NULL";
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        default:
          throw new Error("dapper: unsupported literal in find");
      }
    default:
      throw new Error(`dapper: unsupported expression '${e.kind}' in find`);
  }
}

/** The `authz-filter` sentinels as raw Postgres SQL (M-T9.9 / M-T6.29).  A
 *  discriminated node, so a missing arm is a `tsc` error here rather than a
 *  fall-through to `whereToSql`'s `default:`, where the `deny` carve-out would
 *  reach the generic dispatcher and CRASH codegen on this adapter.  That is the
 *  whole point of giving the sentinel its own `ExprIR.kind`. */
function authzFilterToSql(e: Extract<ExprIR, { kind: "authz-filter" }>): string {
  switch (e.filter.kind) {
    // DENY carve-out (deny-wins).  The always-false
    // term, ANDed into every read SELECT (and into the write-scope existence
    // pre-guard).  `1 = 0` rather than `FALSE` to match the JPQL/Java rendering
    // and stay a valid standalone predicate in every SQL position.
    case "deny":
      return "1 = 0";
    // `deep`/`global` read level (hierarchical tenancy) — the materialized-path
    // descendant-or-self sentinel.  It is SQL-expressible in principle, but its
    // `currentUser.<claim>` sub-expressions would have to reach
    // `collectFilterPrincipalRefs` (which does not descend into this node) to
    // bind the `@__cu_*` params.  Until that lands it is a DOCUMENTED capability
    // boundary, not a crash: `validateDapperSupport` rejects a hierarchical
    // scope filter under `persistence: dapper` with `loom.dapper-unsupported`
    // before codegen runs, so this throw is unreachable defence-in-depth.
    case "scope":
      throw new Error(
        `dapper: hierarchical tenancy scope filter on '${e.aggregate}' is outside the ` +
          `Dapper SQL subset; use 'persistence: efcore'.`,
      );
    default: {
      const _exhaustive: never = e.filter;
      throw new Error(`unhandled authz-filter kind: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

/** Dapper param name for a `currentUser.<claim>` principal reference in a
 *  capability filter (`this.tenantId == currentUser.tenantId` →
 *  `@__cu_tenantId`).  Stable per claim so repeated references share one param. */
function currentUserParam(member: string): string {
  return `__cu_${member}`;
}

/** A `currentUser.<claim>` reference found in a filter / find / retrieval
 *  predicate: the Dapper param name it lowers to (`__cu_<claim>`) and the
 *  principal claim property (PascalCased) read to bind it.  The accessor BASE
 *  is chosen at the binding site — the ambient
 *  `RequestContext.Current!.CurrentUser!` for queries with no principal param
 *  (GetById / FindManyByIds / retrievals), or the `currentUser` method
 *  parameter the shared repository interface adds to a `currentUser`-referencing
 *  find. */
export interface FilterPrincipalRef {
  param: string; // `__cu_tenantId`
  claimProp: string; // `TenantId`
}

/** `${param} = ${base}.${claimProp}` fields for a `new { … }` / DynamicParameters. */
export function principalFields(refs: readonly FilterPrincipalRef[], base: string): string[] {
  return refs.map((r) => `${r.param} = ${base}.${r.claimProp}`);
}

/** Collect the distinct `currentUser.<claim>` references across the given
 *  predicates (deduped by claim), so the repository can bind each
 *  `@__cu_<claim>` param from the principal on every SELECT. */
export function collectFilterPrincipalRefs(filters: readonly ExprIR[]): FilterPrincipalRef[] {
  const byParam = new Map<string, FilterPrincipalRef>();
  const walk = (e: ExprIR): void => {
    switch (e.kind) {
      case "member":
        if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
          const param = currentUserParam(e.member);
          if (!byParam.has(param)) byParam.set(param, { param, claimProp: upperFirst(e.member) });
        } else {
          walk(e.receiver);
        }
        return;
      case "paren":
        walk(e.inner);
        return;
      case "unary":
        walk(e.operand);
        return;
      case "binary":
        walk(e.left);
        walk(e.right);
        return;
      default:
        return;
    }
  };
  for (const f of filters) walk(f);
  return [...byParam.values()];
}

/** Dedup principal refs by param name (a claim referenced by both a capability
 *  filter and a find's own predicate binds one parameter). */
function dedupPrincipalRefs(refs: readonly FilterPrincipalRef[]): FilterPrincipalRef[] {
  return [...new Map(refs.map((r) => [r.param, r])).values()];
}

/** Find/method parameter list.  A `currentUser`-referencing find carries a
 *  trailing `User currentUser` parameter (after any page args, before the
 *  CancellationToken) — the SAME position the shared `I<Agg>Repository`
 *  interface renders (`renderParamsWithCt`), so the Dapper impl matches it. */
function renderParams(params: ParamIR[], extra: readonly string[] = [], usesUser = false): string {
  const ps = params.map((p) => `${renderCsType(p.type)} ${escapeCsharpIdent(p.name)}`);
  return [
    ...ps,
    ...extra,
    ...(usesUser ? ["User currentUser"] : []),
    "CancellationToken cancellationToken = default",
  ].join(", ");
}

/** The Dapper audit staging seam (audit-and-logging.md).
 *
 *  The command handlers stage an `AuditRecord` for an audited aggregate
 *  REGARDLESS of its persistence shape, so every Dapper repository emitter —
 *  relational, document AND event-sourced — has to drain that buffer.  Wiring
 *  only the relational one is what made document- and event-sourced-shaped
 *  audited aggregates compile clean and then silently drop their audit rows;
 *  this seam exists so the three emitters cannot drift apart again.
 *
 *  The drain runs on the repository's OPEN transaction, so the audit rows and
 *  the state change commit or roll back together — the Dapper mirror of the EF
 *  writer's `_db.AuditRecords.Add` riding the shared `SaveChangesAsync`.
 *  `before`/`after` arrive as already-serialized JSON strings (the handler
 *  serializes the wire snapshots), so they CAST to jsonb.
 *
 *  `begin`/`commit` are supplied for the emitters whose save/delete paths are
 *  otherwise a single un-transacted statement (document, event-sourced); the
 *  relational path already opens `__tx` unconditionally in `SaveAsync` and uses
 *  only `flush` there. */
function dapperAuditSeam(
  agg: EnrichedAggregateIR,
  ns?: string,
): {
  on: boolean;
  usingLine: string | null;
  field: string | null;
  ctorParam: string;
  ctorAssign: string | null;
  txArg: string;
  begin: string | null;
  flush: string[];
  commit: string | null;
} {
  const on = aggHasAuditedTarget(agg);
  return {
    on,
    usingLine: on && ns ? `using ${ns}.Application.Common;` : null,
    field: on ? "    private readonly IAuditWriter _audit;" : null,
    ctorParam: on ? ", IAuditWriter audit" : "",
    ctorAssign: on ? "        _audit = audit;" : null,
    txArg: on ? "transaction: __tx, " : "",
    begin: on
      ? "        await using var __tx = await conn.BeginTransactionAsync(cancellationToken);"
      : null,
    flush: on
      ? [
          "        foreach (var __ar in _audit.Drain())",
          "        {",
          "            // `Before`/`After` bind as `JsonNode?` on the POCO (uniform with the",
          "            // other four backends); Dapper has no jsonb parameter for a node, so",
          "            // they go over the wire as text and are CAST back — the same shape",
          "            // `actor` already uses.",
          `            await conn.ExecuteAsync(new CommandDefinition("INSERT INTO audit_records (audit_id, operation_id, action, target_type, target_id, actor, before, after, at, status, correlation_id, scope_id, parent_id) VALUES (@audit_id, @operation_id, @action, @target_type, @target_id, CAST(@actor AS jsonb), CAST(@before AS jsonb), CAST(@after AS jsonb), @at, @status, @correlation_id, @scope_id, @parent_id)", new { audit_id = __ar.AuditId, operation_id = __ar.OperationId, action = __ar.Action, target_type = __ar.TargetType, target_id = __ar.TargetId, actor = __ar.Actor, before = __ar.Before?.ToJsonString(), after = __ar.After?.ToJsonString(), at = __ar.At, status = __ar.Status, correlation_id = __ar.CorrelationId, scope_id = __ar.ScopeId, parent_id = __ar.ParentId }, transaction: __tx, cancellationToken: cancellationToken));`,
          "        }",
        ]
      : [],
    commit: on ? "        await __tx.CommitAsync(cancellationToken);" : null,
  };
}

// ---------------------------------------------------------------------------
// Per-aggregate Dapper repository.
// ---------------------------------------------------------------------------

export function renderDapperRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  retrievals: RetrievalIR[] = [],
  /** The request principal's id property (PascalCased, e.g. `Id`) — present
   *  when the deployable carries auth.  A bare `currentUser` stamp value
   *  (`createdBy := currentUser`) resolves to `RequestContext.Current!.CurrentUser!.<actorIdProp>`,
   *  mirroring the EF AuditableInterceptor.  Undefined ⇒ no principal stamp
   *  reaches this emitter (rejected upstream by loom.stamp-principal-without-auth). */
  actorIdProp?: string,
  /** shape: embedded: each containment folds into one JSONB column (serialised
   *  part snapshots) instead of a child table.  Adds the STJ `__json` options
   *  field the containment (de)serialisation uses. */
  embedded = false,
  /** TPH (`sharedTable`) concrete: the aggregate persists to the shared table
   *  named for `baseName`, discriminated by a `kind` column carrying
   *  `discriminator` (this concrete's name).  Every SELECT splices `kind = '…'`
   *  into its WHERE; every INSERT writes the `kind` literal; the id class is the
   *  shared `<Base>Id` (this concrete declares no id of its own).  Undefined for
   *  a standalone aggregate / TPC concrete (byte-identical off this path). */
  tph?: { baseName: string; discriminator: string },
): string {
  const idClass = tph ? `${tph.baseName}Id` : `${agg.name}Id`;
  const table = sqlIdent(tableOf(tph ? tph.baseName : agg.name));
  const sqlCtx: WhereSqlCtx = { agg, table };
  const cols = columnsOf(agg, embedded, idClass);
  const colList = cols.map((c) => sqlIdent(c.col)).join(", ");
  const insertVals = cols.map((c) => `@${c.col}${c.cast}`).join(", ");
  // TPH INSERT splices the `kind` discriminator literal right after `id` (the
  // SELECT `colList` stays discriminator-free — the discriminator lives in the
  // spliced WHERE filter, not the projected columns).
  const insertColList = tph
    ? [sqlIdent(cols[0]!.col), "kind", ...cols.slice(1).map((c) => sqlIdent(c.col))].join(", ")
    : colList;
  const kindLiteral = tph ? `'${tph.discriminator.replace(/'/g, "''")}'` : "";
  // Lifecycle stamps (`stamp onCreate/onUpdate { field: expr }` →
  // `contextStamps`).  EF applies these via SaveChangesInterceptor (writing the
  // stamped column through EF metadata, so the entity's `{ get; private set; }`
  // is honoured).  The Dapper repository can't mutate those private setters, so
  // it computes each stamp value into a local and BINDS it as the column's
  // upsert parameter (reaching both the INSERT VALUES and the ON CONFLICT SET):
  //   - onCreate assignments are INSERT-only — bound as the column parameter and
  //     EXCLUDED from the ON CONFLICT UPDATE SET, so an existing row keeps its
  //     original value.
  //   - onUpdate assignments are bound on both INSERT and UPDATE (EF stamps
  //     onUpdate at Added too) — the column stays in the SET.
  // Neither mutates the in-memory aggregate (its stamped fields are private-set;
  // the crudish update handler returns Unit, so no in-memory projection needs it).
  const stampRules = agg.contextStamps ?? [];
  const onCreateStamps = stampRules
    .filter((r) => r.event === "create")
    .flatMap((r) => r.assignments);
  const onUpdateStamps = stampRules
    .filter((r) => r.event === "update")
    .flatMap((r) => r.assignments);
  const onCreateCols = new Set(onCreateStamps.map((a) => snake(a.field)));
  const onUpdateCols = new Set(onUpdateStamps.map((a) => snake(a.field)));
  const upsertSet = cols
    .filter((c) => c.col !== "id" && !onCreateCols.has(c.col))
    .map((c) => `${sqlIdent(c.col)} = excluded.${sqlIdent(c.col)}`)
    .join(", ");
  const createLocal = (col: string): string => `__create_${col}`;
  const updateLocal = (col: string): string => `__stamp_${col}`;
  const stampParam = (col: string): string | null =>
    onCreateCols.has(col) ? createLocal(col) : onUpdateCols.has(col) ? updateLocal(col) : null;
  const saveParams = cols
    .map((c) => `${escapeCsharpIdent(c.col)} = ${stampParam(c.col) ?? c.save}`)
    .join(", ");
  // A stamp value referencing the request principal resolves through the same
  // ambient accessor the EF AuditableInterceptor uses: `currentUser.<claim>` →
  // `RequestContext.Current!.CurrentUser!.<Claim>` (via `currentUserExpr`), and
  // a bare `currentUser` → the principal's id (`.<actorIdProp>`), the .NET
  // analogue of Java's `currentUser.id()`.  Non-principal stamps (`now()`) are
  // byte-identical (the ctx just carries an unused accessor).
  const renderStampValue = (value: ExprIR): string =>
    value.kind === "ref" && value.refKind === "current-user" && actorIdProp
      ? `${AMBIENT_CURRENT_USER}.${actorIdProp}`
      : renderCsExpr(value, {
          thisName: "aggregate",
          ...(actorIdProp ? { currentUserExpr: AMBIENT_CURRENT_USER } : {}),
        });
  const stampLines: string[] = [
    ...onCreateStamps.map(
      (a) => `        var ${createLocal(snake(a.field))} = ${renderStampValue(a.value)};`,
    ),
    ...onUpdateStamps.map(
      (a) => `        var ${updateLocal(snake(a.field))} = ${renderStampValue(a.value)};`,
    ),
  ];

  // Optimistic concurrency (`versioned`, default-on): the guarded upsert seeds
  // `version = 1` on INSERT and, on ON CONFLICT, bumps `version = version + 1`
  // ONLY when the row's current version matches the expected version (the
  // client's `If-Match`, or the loaded aggregate's own version) — a CAS in the
  // conflict branch's `WHERE`.  A stale row / stale precondition makes the
  // UPDATE match zero rows, so `ExecuteAsync` returns 0 and we throw
  // `ConcurrencyConflictException` (→ 409 via DomainExceptionFilter's Dapper
  // arm) — the persistence-neutral mirror of EF's `IsConcurrencyToken()` +
  // `DbUpdateConcurrencyException`.  The expected version is read from the
  // ambient RequestContext (populated from `If-Match` by
  // RequestContextMiddleware — persistence-independent), EXACTLY as the EF
  // repository threads it, so the port signature `SaveAsync(agg, ct)` is
  // unchanged.  A non-versioned aggregate keeps the blind upsert below
  // (byte-identical).
  const versioned = aggregateIsVersioned(agg);
  const versionCol = "version";
  const upsertSetNoVersion = cols
    .filter((c) => c.col !== "id" && c.col !== versionCol && !onCreateCols.has(c.col))
    .map((c) => `${sqlIdent(c.col)} = excluded.${sqlIdent(c.col)}`)
    .join(", ");
  const versionedInsertVals = cols
    .map((c) => (c.col === versionCol ? "1" : `@${c.col}${c.cast}`))
    .join(", ");
  // TPH INSERT VALUES: the `kind` literal follows the `id` value (matching
  // `insertColList`).  Off the TPH path these equal `insertVals` /
  // `versionedInsertVals` (byte-identical).
  const insertValsTph = tph
    ? [
        `@${cols[0]!.col}${cols[0]!.cast}`,
        kindLiteral,
        ...cols.slice(1).map((c) => `@${c.col}${c.cast}`),
      ].join(", ")
    : insertVals;
  const versionedInsertValsTph = tph
    ? [
        `@${cols[0]!.col}${cols[0]!.cast}`,
        kindLiteral,
        ...cols.slice(1).map((c) => (c.col === versionCol ? "1" : `@${c.col}${c.cast}`)),
      ].join(", ")
    : versionedInsertVals;
  const versionedSetClause = upsertSetNoVersion
    ? `${upsertSetNoVersion}, ${versionCol} = ${table}.${versionCol} + 1`
    : `${versionCol} = ${table}.${versionCol} + 1`;
  // SaveAsync writes the root upsert, join-table replaces, containment-tree
  // replaces, and the provenance flush as ONE unit of work: a crash between the
  // full-list-replace DELETE and its re-INSERT would otherwise permanently lose
  // an aggregate's children/associations (autocommit).  The EF path is atomic
  // via SaveChanges and the Hono path via `db.transaction`; this matches them.
  // `transaction: __tx` is threaded into every save-path CommandDefinition, and
  // the body commits before dispatching events (see renderRelationalRepository).
  const saveUpsertLines = versioned
    ? [
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        "        await using var __tx = await conn.BeginTransactionAsync(cancellationToken);",
        "        var __expected = RequestContext.Current?.ExpectedVersion ?? aggregate.Version;",
        `        var __affected = await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (${insertColList}) VALUES (${versionedInsertValsTph}) ON CONFLICT (id) DO UPDATE SET ${versionedSetClause} WHERE ${table}.${versionCol} = @ExpectedVersion", new { ${saveParams}, ExpectedVersion = __expected }, transaction: __tx, cancellationToken: cancellationToken));`,
        `        if (__affected == 0) throw new ConcurrencyConflictException("The resource was modified by another request; reload and retry.");`,
      ]
    : [
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        "        await using var __tx = await conn.BeginTransactionAsync(cancellationToken);",
        `        await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (${insertColList}) VALUES (${insertValsTph}) ON CONFLICT (id) DO UPDATE SET ${upsertSet}", new { ${saveParams} }, transaction: __tx, cancellationToken: cancellationToken));`,
      ];

  // Capability filters (`filter !this.isDeleted`, `filter this.tenantId ==
  // currentUser.tenantId`) AND into every read (GetById / FindManyByIds /
  // finds / retrievals) — Dapper has no EF HasQueryFilter, so the predicate is
  // spliced into each SELECT's WHERE.  A principal-referencing filter lowers
  // `currentUser.<claim>` to a `@__cu_<claim>` Dapper param bound from the
  // ambient request principal (`filterPrincipalRefs`), threaded into every
  // query's parameter object — the raw-SQL mirror of EF's per-request
  // HasQueryFilter.  A predicate outside the Dapper SQL subset throws here
  // (loud) rather than silently dropping the filter — half-applying a
  // soft-delete/tenant filter would be a correctness hole.
  const capabilityFilters = agg.contextFilters ?? [];
  // The TPH discriminator predicate (`kind = '<Concrete>'`) is ANDed into every
  // SELECT alongside the capability filters — the raw-SQL mirror of EF's
  // per-derived-type discriminator filter, so a concrete repo never reads a
  // sibling's rows out of the shared table.
  // Each capability predicate paired with the capability that CONTRIBUTED it
  // (`agg.contextFilterOrigins`, index-aligned with `agg.contextFilters`) — the
  // Dapper twin of the EF `(capability, filterName)` pairs in `emit/repository.ts`.
  // The origin is what an `ignoring <Cap>` clause resolves against; a filter
  // with no origin (a plain context filter) can only be dropped by `ignoring *`.
  const filterOrigins = agg.contextFilterOrigins ?? [];
  const capabilityFilterParts: {
    sql: string;
    origin: string | undefined;
    bypassable: boolean;
  }[] = capabilityFilters.map((p, i) => {
    try {
      // A `policy { deny on X }` always-false sentinel is a CARVE-OUT, not a
      // capability filter: deny wins over an authored `ignoring *`, so this
      // conjunct is never dropped (the raw-SQL twin of the EF rule in
      // `find-emit.ts` — and of the TPH discriminator rule just below).
      return { sql: whereToSql(p, sqlCtx), origin: filterOrigins[i], bypassable: !isDenyFilter(p) };
    } catch {
      throw new Error(
        `dapper: capability filter on '${agg.name}' is outside the Dapper SQL subset; ` +
          `use 'persistence: efcore' or simplify the predicate.`,
      );
    }
  });
  /** The capability predicates a read carrying `bypass` still applies
   *  (named-filter-bypass.md §11).  `ignoring *` drops every BYPASSABLE one;
   *  `ignoring A, B` drops the ones those capabilities contributed.  Dapper has
   *  no EF `IgnoreQueryFilters`, so the bypass is expressed by OMITTING the
   *  conjunct from the generated WHERE — the raw-SQL equivalent. */
  const capabilityFilterSqlFor = (bypass?: {
    bypassAll?: boolean;
    bypassCaps?: string[];
  }): string | null => {
    const caps = new Set(bypass?.bypassCaps ?? []);
    const kept = capabilityFilterParts.filter(
      (p) =>
        !p.bypassable || !(bypass?.bypassAll === true || (p.origin != null && caps.has(p.origin))),
    );
    return kept.length > 0 ? kept.map((p) => p.sql).join(" AND ") : null;
  };
  /** The full spliced WHERE fragment (TPH discriminator + surviving capability
   *  predicates).  The TPH discriminator is NEVER bypassable: it is a type
   *  mapping, not a query filter — EF's `IgnoreQueryFilters()` leaves it in
   *  place too, so a concrete repo can never read a sibling's rows. */
  const filterSqlFor = (bypass?: { bypassAll?: boolean; bypassCaps?: string[] }): string | null =>
    [tph ? `kind = ${kindLiteral}` : null, capabilityFilterSqlFor(bypass)]
      .filter((s) => s !== null)
      .join(" AND ") || null;
  const andFilter = (
    existingWhere: boolean,
    bypass?: { bypassAll?: boolean; bypassCaps?: string[] },
  ): string => {
    const sql = filterSqlFor(bypass);
    return sql ? `${existingWhere ? " AND " : " WHERE "}${sql}` : "";
  };
  // Principal-filter param bindings appended to every SELECT's parameter object
  // (`__cu_tenantId = RequestContext.Current!.CurrentUser!.TenantId`).  Empty
  // for a non-principal (or no) filter, so those SELECTs stay byte-identical.
  // GetById / FindManyByIds have no `currentUser` method param, so they bind
  // from the ambient accessor.
  const filterPrincipalRefs = collectFilterPrincipalRefs(capabilityFilters);
  const princFields = principalFields(filterPrincipalRefs, AMBIENT_CURRENT_USER);
  // Comma-prefixed suffix appended inside a `new { … }` that already has fields
  // (GetById / FindManyByIds).
  const princSuffix = princFields.length > 0 ? `, ${princFields.join(", ")}` : "";

  // Command-load path (authorization.md): the write-scope
  // existence pre-guard behind `GetByIdForWriteAsync`, the raw-SQL twin of the
  // EF `AnyAsync(x => x.Id == id && (<scope>))` in `emit/repository.ts`.  EF
  // gets the READ query-filter applied to that `Any` for free; Dapper has no
  // HasQueryFilter, so the read `filterSql` is spliced in explicitly here —
  // without it the write guard would be WIDER than the read scope on this
  // adapter, which is the whole invariant the seam exists to hold.  A row the
  // caller may READ but not WRITE reads as missing → 404 (no existence leak).
  // Principal claims bind from the ambient accessor (re-read per call), and the
  // param set is the UNION of the read filter's and the write scope's claims —
  // a scope claim the read filter never mentions must still be bound.
  const writeScopeSql = agg.writeScopeFilter
    ? (() => {
        try {
          return whereToSql(agg.writeScopeFilter, sqlCtx);
        } catch {
          throw new Error(
            `dapper: write-scope filter on '${agg.name}' is outside the Dapper SQL subset; ` +
              `use 'persistence: efcore' or simplify the policy.`,
          );
        }
      })()
    : null;
  const writePrincFields = principalFields(
    dedupPrincipalRefs([
      ...filterPrincipalRefs,
      ...collectFilterPrincipalRefs(agg.writeScopeFilter ? [agg.writeScopeFilter] : []),
    ]),
    AMBIENT_CURRENT_USER,
  );
  const writePrincSuffix = writePrincFields.length > 0 ? `, ${writePrincFields.join(", ")}` : "";
  const writeScopeMethod: string[] = writeScopeSql
    ? [
        `    public async Task<${agg.name}?> GetByIdForWriteAsync(${idClass} id, CancellationToken cancellationToken = default)`,
        "    {",
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        `        var __inScope = await conn.ExecuteScalarAsync<bool>(new CommandDefinition("SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = @id AND (${writeScopeSql})${andFilter(true)})", new { id = id.Value${writePrincSuffix} }, cancellationToken: cancellationToken));`,
        "        if (!__inScope) return null;",
        "        return await GetByIdAsync(id, cancellationToken);",
        "    }",
        "",
      ]
    : [];

  const mapBody = cols.map((c) => `            ${c.stateProp} = ${c.hydrate},`);

  // Reference collections (`X id[]` → AssociationIR, one join table each).
  // `X id[]` is contractually a set (membership only, no order), so the join
  // row is just its composite (owner, target) PK — no payload column.
  // Loads: a private LoadRefsAsync bulk-fills every root's list (ordered by
  // the target FK id for deterministic read-back); GetById funnels its single
  // root through it too.  Saves: full-list replace — DELETE owner rows +
  // re-INSERT (delete+insert is semantically identical for a full-list
  // replace and keeps the SQL trivial).  Deletes: join rows go first (the
  // Dapper schema emits no FK cascade).
  const associations = agg.associations ?? [];
  const hasAssoc = associations.length > 0;
  const loadRefsMethod = hasAssoc
    ? lines(
        `    private static async Task LoadRefsAsync(NpgsqlConnection conn, List<${agg.name}> roots, CancellationToken cancellationToken)`,
        "    {",
        "        if (roots.Count == 0) return;",
        "        var __ids = roots.Select(x => x.Id.Value).ToArray();",
        ...associations.flatMap((a) => {
          const ownerCs = idTypes(agg.idValueType).cs;
          const targetCs = idTypes(a.valueType).cs;
          const prop = upperFirst(a.fieldName);
          return [
            `        var __${a.fieldName}Rows = (await conn.QueryAsync<(${ownerCs} owner, ${targetCs} target)>(new CommandDefinition("SELECT ${sqlIdent(a.ownerFk)}, ${sqlIdent(a.targetFk)} FROM ${sqlIdent(a.joinTable)} WHERE ${sqlIdent(a.ownerFk)} = ANY(@ids) ORDER BY ${sqlIdent(a.ownerFk)}, ${sqlIdent(a.targetFk)}", new { ids = __ids }, cancellationToken: cancellationToken))).ToList();`,
            `        var __${a.fieldName}ByOwner = __${a.fieldName}Rows.GroupBy(t => t.owner).ToDictionary(g => g.Key, g => g.Select(t => new ${a.targetAgg}Id(t.target)).ToList());`,
            `        foreach (var __root in roots)`,
            `        {`,
            `            __root.${prop} = __${a.fieldName}ByOwner.TryGetValue(__root.Id.Value, out var __${a.fieldName}List) ? __${a.fieldName}List : new List<${a.targetAgg}Id>();`,
            `        }`,
          ];
        }),
        "    }",
      )
    : "";
  const assocSaveLines = associations.flatMap((a) => {
    const prop = upperFirst(a.fieldName);
    return [
      `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${sqlIdent(a.joinTable)} WHERE ${sqlIdent(a.ownerFk)} = @id", new { id = aggregate.Id.Value }, transaction: __tx, cancellationToken: cancellationToken));`,
      `        foreach (var __t in aggregate.${prop})`,
      "        {",
      `            await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${sqlIdent(a.joinTable)} (${sqlIdent(a.ownerFk)}, ${sqlIdent(a.targetFk)}) VALUES (@o, @t)", new { o = aggregate.Id.Value, t = __t.Value }, transaction: __tx, cancellationToken: cancellationToken));`,
      "        }",
    ];
  });
  // Nested entity parts (`contains lineItems: LineItem[]`).  Reads funnel every
  // root through `HydrateAsync` (loads each child table + reconstructs the root
  // with its children in State); saves full-list-replace each child table;
  // deletes cascade the children first.  `hasContains` and reference-collection
  // associations COMPOSE: when both are present a read hydrates the
  // child tables first, then `LoadRefsAsync` post-sets the writable
  // ref-collection list on the reconstructed roots (the two hydrate passes run
  // in sequence — columnsOf excludes the assoc field, so HydrateAsync's
  // `_Create(State)` leaves it defaulted for LoadRefsAsync to fill).
  // Relational: containments are child tables (partChildrenOf).  Embedded folds
  // each into a JSONB column instead (added to `cols` above), so no child
  // tables / HydrateAsync — the flat `Map` hydrates from the containment columns.
  // A TPH concrete's contained parts hang off the SHARED base row, so the
  // top-level FK targets the base table (`tph.baseName`) rather than the
  // concrete (which owns no table) — EF's TPT-via-contains.  Off the TPH path
  // this is `agg.name` (byte-identical).
  const partChildren = embedded ? [] : partChildrenOf(agg, tph ? tph.baseName : agg.name);
  const hasContains = partChildren.length > 0;
  // Insert one part row + recurse into its own contained parts, FK'ing each
  // grandchild to THIS part's row (`ownerIdExpr` / `ownerAccessor` walk the
  // in-memory object graph).  A leaf part emits just the loop + INSERT — the
  // exact single-level shape the pre-recursion emitter produced.
  const saveInsert = (pc: PartChild, ownerIdExpr: string, ownerAccessor: string): string[] => {
    const insertCols = [
      "id",
      sqlIdent(pc.parentFk),
      ...pc.fieldCols.map((c) => sqlIdent(c.col)),
    ].join(", ");
    const insertVals = [
      "@id",
      "@" + pc.parentFk,
      ...pc.fieldCols.map((c) => `@${c.col}${c.cast}`),
    ].join(", ");
    const insertParams = [
      `id = ${pc.childVar}.Id.Value`,
      `${pc.parentFk} = ${ownerIdExpr}`,
      ...pc.fieldCols.map((c) => `${escapeCsharpIdent(c.col)} = ${c.save}`),
    ].join(", ");
    const iter = pc.cont.collection
      ? `        foreach (var ${pc.childVar} in ${ownerAccessor})`
      : `        if (${ownerAccessor} is { } ${pc.childVar})`;
    return [
      iter,
      "        {",
      `            await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${sqlIdent(pc.table)} (${insertCols}) VALUES (${insertVals})", new { ${insertParams} }, transaction: __tx, cancellationToken: cancellationToken));`,
      ...pc.children.flatMap((gc) =>
        saveInsert(gc, `${pc.childVar}.Id.Value`, `${pc.childVar}.${upperFirst(gc.cont.name)}`),
      ),
      "        }",
    ];
  };
  // Full-list replace per root containment: delete the owner's rows (ON DELETE
  // CASCADE clears any grandchildren) then re-insert the whole subtree.
  const containSaveLines = partChildren.flatMap((pc) => [
    `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${sqlIdent(pc.table)} WHERE ${sqlIdent(pc.parentFk)} = @id", new { id = aggregate.Id.Value }, transaction: __tx, cancellationToken: cancellationToken));`,
    ...saveInsert(pc, "aggregate.Id.Value", `aggregate.${upperFirst(pc.cont.name)}`),
  ]);
  // DeleteAsync is TRANSACTIONAL whenever it issues more than one statement, or
  // when the aggregate is audited.
  //
  //   - multi-statement: a `contains`/`X id[]` aggregate deletes its child and
  //     join tables before the root.  Autocommitting those separately means a
  //     crash mid-delete leaves the root alive with its children already gone —
  //     the same data-loss class `SaveAsync` was made transactional for
  //     (docs/audits/repo-code-review-2026-07.md T3), which fixed the save path
  //     and left the delete path behind.
  //   - audited: the handler stages the audit row before calling in, and it has
  //     to commit with the delete or roll back with it.
  //
  // A single-statement delete (no children, no associations, not audited) keeps
  // the transaction-free emit byte-identical.
  const delMultiStatement = associations.length > 0 || partChildren.length > 0;
  const delTx = aggHasAuditedTarget(agg) || delMultiStatement ? "transaction: __tx, " : "";
  const assocDeleteLines = associations.map(
    (a) =>
      `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${sqlIdent(a.joinTable)} WHERE ${sqlIdent(a.ownerFk)} = @id", new { id = aggregate.Id.Value }, ${delTx}cancellationToken: cancellationToken));`,
  );
  // Delete only the root-level child tables by owner id; their FK ON DELETE
  // CASCADE removes every nested grandchild row.
  const containDeleteLines = partChildren.map(
    (pc) =>
      `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${sqlIdent(pc.table)} WHERE ${sqlIdent(pc.parentFk)} = @id", new { id = aggregate.Id.Value }, ${delTx}cancellationToken: cancellationToken));`,
  );
  const containMembers = hasContains ? containmentMembers(agg, partChildren, idClass) : [];

  // Provenance flush (provenance.md): drain the per-write lineage buffer and
  // append one `provenance_records` row per write, on the SAME connection as
  // the aggregate upsert (the .NET Dapper mirror of the EF repository's
  // transactional `DrainProv()` staging).  Empty when the aggregate has no
  // provenanced fields (byte-identical to the pre-provenance emit).
  const provFlushLines = agg.fields.some((f) => f.provenanced)
    ? [
        "        foreach (var __lin in aggregate.DrainProv())",
        "        {",
        `            await conn.ExecuteAsync(new CommandDefinition("INSERT INTO provenance_records (trace_id, snapshot_id, target_type, field, inputs, computed_value, at, correlation_id, scope_id, actor_id, parent_id) VALUES (@trace_id, @snapshot_id, @target_type, @field, CAST(@inputs AS jsonb), CAST(@computed_value AS jsonb), @at, @correlation_id, @scope_id, @actor_id, @parent_id)", new { trace_id = Guid.NewGuid().ToString(), snapshot_id = __lin.SnapshotId, target_type = __lin.Target.Type, field = __lin.Target.Field, inputs = System.Text.Json.JsonSerializer.Serialize(__lin.Inputs, ProvJson.Options), computed_value = System.Text.Json.JsonSerializer.Serialize(__lin.ComputedValue, ProvJson.Options), at = DateTime.UtcNow, correlation_id = RequestContext.Current?.CorrelationId, scope_id = RequestContext.Current?.ScopeId, actor_id = RequestContext.Current?.ActorId, parent_id = RequestContext.Current?.ParentId }, transaction: __tx, cancellationToken: cancellationToken));`,
        "        }",
      ]
    : [];

  const auditFlushLines = dapperAuditSeam(agg).flush;

  // A `currentUser`-referencing find takes a `User currentUser` param (named
  // type ⇒ needs `using <ns>.Auth`).  Principal stamps/filters use only the
  // ambient `RequestContext.Current!.CurrentUser!` member access (no type name),
  // so they don't.
  const anyFindUsesUser = (repo?.finds ?? []).some((raw) =>
    findUsesCurrentUser(unionFindAsOptionalTwin(raw, agg.name)),
  );
  const findMethods = (repo?.finds ?? []).map((raw) => {
    const f = unionFindAsOptionalTwin(raw, agg.name);
    const name = upperFirst(f.name);
    const ret = renderCsType(f.returnType);
    const isList = f.returnType.kind === "array";
    // Id-typed params bind their wrapped `.Value` (Dapper has no handler for
    // the strongly-typed id struct); ENUM-typed params bind `.ToString()`;
    // scalars bind directly.
    //
    // The enum arm is not symmetry for its own sake — without it the find 500s.
    // An enum column is `text` on every backend (`columnFor` above declares
    // `sql: "text"` and saves `${acc}.ToString()`), but Dapper's default handler
    // maps a C# enum PARAMETER to its integer ordinal, so the predicate reaches
    // Postgres as `WHERE status = 1` against a text column — `operator does not
    // exist: text = integer`, a 500 at the route.  The SAVE path in this same
    // file spells `.ToString()` for the same reason.
    const paramFields = f.params.map((p) => {
      const pt = p.type.kind === "optional" ? p.type.inner : p.type;
      // The anon-object member name stays the DECLARED name (Dapper binds it to
      // the `@<name>` SQL parameter); the verbatim `@` prefix is only the C#
      // identifier escape, so both halves take it (F2-ADP-7).
      const n = escapeCsharpIdent(p.name);
      if (pt.kind === "id") return `${n} = ${n}.Value`;
      if (pt.kind === "enum") {
        return p.type.kind === "optional" ? `${n} = ${n}?.ToString()` : `${n} = ${n}.ToString()`;
      }
      return n;
    });
    // Bind the find's own params + every `currentUser.<claim>` param the SELECT
    // references — both the capability-filter refs spliced into every WHERE AND
    // any the find's OWN predicate carries (`find mine(): … where this.owner ==
    // currentUser.id`) — deduped by param.  A `currentUser`-referencing find
    // gets a trailing `User currentUser` method parameter (the shared repository
    // interface adds it), so it binds its principal params from that parameter;
    // a non-`currentUser` find (only inheriting the capability filter) binds
    // from the ambient accessor.
    const usesUser = findUsesCurrentUser(f);
    const principalBase = usesUser ? "currentUser" : AMBIENT_CURRENT_USER;
    const findPrincipalRefs = dedupPrincipalRefs([
      ...filterPrincipalRefs,
      ...collectFilterPrincipalRefs(f.filter ? [f.filter] : []),
    ]);
    const findPrincFields = principalFields(findPrincipalRefs, principalBase);
    const allFindParams = [...paramFields, ...findPrincFields];
    const paramObj = allFindParams.length > 0 ? `, new { ${allFindParams.join(", ")} }` : "";
    // Comma-prefixed binding suffix for the find's own `where` params PLUS its
    // principal params — appended inside the paged rows query's `new { __take,
    // __offset, … }`.  The page query's SQL carries the same predicate as the
    // COUNT (via `fromClause`), so it MUST bind the same params, or a paged find
    // with a `where this.f == x` throws on an unbound `@x` at runtime.
    const allFindParamsSuffix = allFindParams.length > 0 ? `, ${allFindParams.join(", ")}` : "";
    let where = "";
    try {
      where = f.filter ? ` WHERE ${whereToSql(f.filter, sqlCtx)}` : "";
    } catch {
      // Unsupported predicate — emit a compile-safe stub.
      return lines(
        `    public Task<${ret}> ${name}(${renderParams(f.params, [], usesUser)})`,
        `        => throw new NotImplementedException("Dapper v1 does not support this find's predicate.");`,
      );
    }
    // An `ignoring` clause on the find (named-filter-bypass.md §11) is STATIC
    // here — it is part of the declaration, so the bypassed capability's
    // predicate is simply never spliced into this method's SQL.
    const sql = `SELECT ${colList} FROM ${table}${where}${andFilter(where !== "", f)}`;
    // Paged-by-default findAll (M-T2.6): a COUNT + a whitelisted ORDER BY / LIMIT
    // / OFFSET page query returning the domain `Paged<Agg>` envelope (1-based).
    // The sort column is resolved from a fixed whitelist server-side (an unknown
    // key falls to `id`) so the interpolated column can't inject SQL; `dir` maps
    // to a literal ASC/DESC.
    if (pagedReturn(f.returnType)) {
      const fromClause = `FROM ${table}${where}${andFilter(where !== "", f)}`;
      const sortArms = sortableFields(agg)
        .filter((wf) => wf !== "id")
        // The KEY is the wire sort name (matched against the request param, so
        // bare); the VALUE is spliced into `ORDER BY {sortColumn}` and is
        // therefore a SQL identifier — a reserved-word column sorted here
        // emitted `ORDER BY order` and failed at RUNTIME, invisible to the
        // compile tier because the whole thing is a string (M-T6.42).
        .map((wf) => `"${wf}" => "${sqlIdent(snake(wf))}"`)
        .join(", ");
      return lines(
        `    public async Task<${ret}> ${name}(${renderParams(f.params, ["int page", "int pageSize", "string sort", "string dir"], usesUser)})`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        var offset = (page - 1) * pageSize;`,
        `        var sortColumn = sort switch { ${sortArms}${sortArms ? ", " : ""}_ => "id" };`,
        `        var sortDir = dir == "desc" ? "DESC" : "ASC";`,
        `        var total = await conn.ExecuteScalarAsync<int>(new CommandDefinition("SELECT COUNT(*) ${fromClause}"${paramObj}, cancellationToken: cancellationToken));`,
        `        var totalPages = pageSize > 0 ? (int)System.Math.Ceiling((double)total / pageSize) : 0;`,
        `        var rows = await conn.QueryAsync<Row>(new CommandDefinition($"SELECT ${colList} ${fromClause} ORDER BY {sortColumn} {sortDir} LIMIT @__take OFFSET @__offset", new { __take = pageSize, __offset = offset${allFindParamsSuffix} }, cancellationToken: cancellationToken));`,
        ...(hasContains
          ? [
              `        var items = await HydrateAsync(conn, rows.ToList(), cancellationToken);`,
              ...(hasAssoc ? [`        await LoadRefsAsync(conn, items, cancellationToken);`] : []),
            ]
          : [
              `        var items = rows.Select(Map).ToList();`,
              ...(hasAssoc ? [`        await LoadRefsAsync(conn, items, cancellationToken);`] : []),
            ]),
        `        return new Paged<${agg.name}>(items, page, pageSize, total, totalPages);`,
        `    }`,
      );
    }
    if (isList) {
      return lines(
        `    public async Task<${ret}> ${name}(${renderParams(f.params, [], usesUser)})`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("${sql}"${paramObj}, cancellationToken: cancellationToken));`,
        ...(hasContains
          ? hasAssoc
            ? [
                `        var __roots = await HydrateAsync(conn, rows.ToList(), cancellationToken);`,
                `        await LoadRefsAsync(conn, __roots, cancellationToken);`,
                `        return __roots;`,
              ]
            : [`        return await HydrateAsync(conn, rows.ToList(), cancellationToken);`]
          : hasAssoc
            ? [
                `        var __roots = rows.Select(Map).ToList();`,
                `        await LoadRefsAsync(conn, __roots, cancellationToken);`,
                `        return __roots;`,
              ]
            : [`        return rows.Select(Map).ToList();`]),
        `    }`,
      );
    }
    // A single-row DECLARED find (`find byX(): T?`) — its predicate is not
    // required to be unique, so two matching rows are legal data.  `QuerySingle
    // OrDefaultAsync` throws `InvalidOperationException` on the second row → a
    // 500 where EF / node / java / python all return the first match, so take
    // the first row explicitly and let the database stop after one.  (GetById
    // is keyed on the PK and stays `QuerySingleOrDefaultAsync` — there a second
    // row would be a corrupt table, and the throw is the right answer.)
    //
    // The absent branch.  A NON-optional single find has no `null` to return —
    // its declared `Task<Agg>` says so — so an empty result set is the domain
    // not-found rung, exactly as it is on the EF adapter (find-emit.ts) and on
    // node / java / python.  This arm emitted a bare `null` for BOTH shapes,
    // which for the non-optional one did not even compile: `dotnet build
    // /warnaserror` rejects it with CS8603 ("Possible null reference return").
    // Nothing caught it because the `dotnet-build` fixture matrix has no
    // `persistence: dapper` case that declares a non-optional find.
    const absent =
      f.returnType.kind === "optional"
        ? "null"
        : `throw new AggregateNotFoundException("not_found")`;
    const absentGuard =
      f.returnType.kind === "optional"
        ? "        if (r is null) return null;"
        : `        if (r is null) throw new AggregateNotFoundException("not_found");`;
    return lines(
      `    public async Task<${ret}> ${name}(${renderParams(f.params, [], usesUser)})`,
      `    {`,
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var r = await conn.QueryFirstOrDefaultAsync<Row>(new CommandDefinition("${sql} LIMIT 1"${paramObj}, cancellationToken: cancellationToken));`,
      ...(hasContains
        ? [
            absentGuard,
            `        var __one = await HydrateAsync(conn, new List<Row> { r }, cancellationToken);`,
            ...(hasAssoc ? [`        await LoadRefsAsync(conn, __one, cancellationToken);`] : []),
            `        return __one[0];`,
          ]
        : hasAssoc
          ? [
              absentGuard,
              `        var __one = new List<${agg.name}> { Map(r) };`,
              `        await LoadRefsAsync(conn, __one, cancellationToken);`,
              `        return __one[0];`,
            ]
          : [`        return r is null ? ${absent} : Map(r);`]),
      `    }`,
    );
  });

  // Retrieval bundles → `Run<Name>Async`, parameterised SQL (where + sort +
  // call-site offset/limit paging).  The `where` is the inlined predicate
  // (criterion bodies included) rendered by `whereToSql`; anything outside the
  // Dapper subset stubs with NotImplementedException, like the find path.
  const retrievalMethods = retrievals.map((r) => {
    const name = upperFirst(r.name);
    let whereSql: string;
    try {
      whereSql = whereToSql(r.where, sqlCtx);
    } catch {
      return lines(
        `    public Task<IReadOnlyList<${agg.name}>> Run${name}Async(${renderRetrievalParamsWithCt(r.params)})`,
        `        => throw new NotImplementedException("Dapper v1 does not support this retrieval's predicate.");`,
      );
    }
    const orderSql =
      r.sort.length > 0
        ? ` ORDER BY ${r.sort
            .map(
              (s) =>
                `${sqlIdent(snake(s.path[0]!.name))} ${s.direction === "desc" ? "DESC" : "ASC"}`,
            )
            .join(", ")}`
        : "";
    // A retrieval's `ignoring` clause arrives at RUNTIME (the `FilterBypass
    // bypass` port param a workflow's inline `Repo.run(...) ignoring …` binds),
    // so unlike the find path the SQL cannot be decided at emit time.  The
    // non-bypassable head (`where` + the TPH discriminator) is baked; each
    // capability predicate is appended only when the caller's `bypass` does not
    // name its contributing capability — the raw-SQL twin of the adapter-side
    // `IgnoreQueryFilters` translation in `emit/repository.ts`.  Paging is
    // concatenated after, so the ORDER BY has to be concatenated too rather
    // than baked into the head.
    const headSql = `SELECT ${colList} FROM ${table} WHERE ${whereSql}${tph ? ` AND kind = ${kindLiteral}` : ""}`;
    const bypassLines =
      capabilityFilterParts.length > 0
        ? [
            `        var __caps = new List<string>();`,
            ...capabilityFilterParts.map((part) => {
              // A non-bypassable conjunct (the `policy { deny }` sentinel) is
              // added unconditionally — no runtime `bypass` can drop it.
              const guard = !part.bypassable
                ? ""
                : part.origin != null
                  ? `if (!bypass.All && bypass.Capabilities?.Contains(${JSON.stringify(part.origin)}) != true) `
                  : `if (!bypass.All) `;
              return `        ${guard}__caps.Add("${part.sql}");`;
            }),
            `        var sql = "${headSql}" + (__caps.Count > 0 ? " AND " + string.Join(" AND ", __caps) : "")${orderSql ? ` + "${orderSql}"` : ""};`,
          ]
        : [`        var sql = "${headSql}${orderSql}";`];
    const paramAdds = [
      ...r.params.map((p) => {
        const pt = p.type.kind === "optional" ? p.type.inner : p.type;
        const n = escapeCsharpIdent(p.name);
        const val = pt.kind === "id" ? `${n}.Value` : n;
        return `        p.Add("${p.name}", ${val});`;
      }),
      // Principal params (`__cu_<claim>`) — the spliced capability filter's refs
      // plus any the retrieval's own `where` carries — bound from the ambient
      // request principal (the retrieval method takes no `currentUser` param).
      ...dedupPrincipalRefs([...filterPrincipalRefs, ...collectFilterPrincipalRefs([r.where])]).map(
        (pr) => `        p.Add("${pr.param}", ${AMBIENT_CURRENT_USER}.${pr.claimProp});`,
      ),
    ];
    return lines(
      `    public async Task<IReadOnlyList<${agg.name}>> Run${name}Async(${renderRetrievalParamsWithCt(r.params)})`,
      `    {`,
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      ...bypassLines,
      `        var p = new DynamicParameters();`,
      ...paramAdds,
      `        if (page is { } pg)`,
      `        {`,
      `            if (pg.limit is { } lim) { sql += " LIMIT @__lim"; p.Add("__lim", lim); }`,
      `            if (pg.offset is { } off) { sql += " OFFSET @__off"; p.Add("__off", off); }`,
      `        }`,
      `        var rows = await conn.QueryAsync<Row>(new CommandDefinition(sql, p, cancellationToken: cancellationToken));`,
      ...(hasContains
        ? hasAssoc
          ? [
              `        var __roots = await HydrateAsync(conn, rows.ToList(), cancellationToken);`,
              `        await LoadRefsAsync(conn, __roots, cancellationToken);`,
              `        return __roots;`,
            ]
          : [`        return await HydrateAsync(conn, rows.ToList(), cancellationToken);`]
        : [`        return rows.Select(Map).ToList();`]),
      `    }`,
    );
  });

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `    public async Task DeleteAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
        `    {`,
        `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
        delTx
          ? "        await using var __tx = await conn.BeginTransactionAsync(cancellationToken);"
          : null,
        ...assocDeleteLines,
        ...containDeleteLines,
        `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${table} WHERE id = @id", new { id = aggregate.Id.Value }, ${delTx}cancellationToken: cancellationToken));`,
        // Drain the staged `destroy audited` row onto the same transaction.
        // Gated on the AUDIT seam, not on `delTx` — `delTx` is now also set for
        // an un-audited multi-statement delete, which has nothing to drain.
        ...auditFlushLines,
        delTx ? "        await __tx.CommitAsync(cancellationToken);" : null,
        `    }`,
      )
    : "";

  return (
    lines(
      "// Auto-generated.  Dapper persistence (persistence: dapper).",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Common;`,
      // `User currentUser` param on a `currentUser`-referencing find.
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      // IAuditWriter — the staging port drained by SaveAsync.
      auditFlushLines.length > 0 ? `using ${ns}.Application.Common;` : null,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    private readonly IDomainEventDispatcher _events;",
      // The request-scoped audit buffer the handler staged onto; drained inside
      // SaveAsync's transaction (see `auditFlushLines`).
      auditFlushLines.length > 0 ? "    private readonly IAuditWriter _audit;" : null,
      // shape: embedded: the STJ options the containment-column (de)serialisation
      // uses (Web defaults — matching the document path + the entity snapshots).
      embedded
        ? "    private static readonly System.Text.Json.JsonSerializerOptions __json =\n        new(System.Text.Json.JsonSerializerDefaults.Web);"
        : null,
      "",
      auditFlushLines.length > 0
        ? `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events, IAuditWriter audit)`
        : `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events)`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      auditFlushLines.length > 0 ? "        _audit = audit;" : null,
      "    }",
      "",
      "    private sealed class Row",
      "    {",
      // Only a non-nullable reference type (string) needs the `= default!`
      // initializer to suppress CS8618; value types + nullable types default
      // on their own.  An auto-property block takes a trailing `;` ONLY when an
      // initializer follows (`{ get; set; } = default!;`) — a bare `{ get; set; };`
      // is a CS1597 error, so the no-initializer arm ends at `}`.
      ...cols.map(
        (c) =>
          `        public ${c.rowCs} ${escapeCsharpIdent(c.col)} { get; set; }${c.rowCs === "string" ? " = default!;" : ""}`,
      ),
      "    }",
      "",
      // When the aggregate has containments, every read reconstructs the root
      // through `HydrateAsync` (which builds the State inline with its children),
      // so the flat `Map` helper is unused — skip it to keep `/warnaserror`
      // clean.  Otherwise the flat root mapper stands.
      ...(hasContains
        ? []
        : [
            `    private static ${agg.name} Map(Row r) =>`,
            `        ${agg.name}._Create(new ${agg.name}.State`,
            "        {",
            ...mapBody,
            "        });",
            "",
          ]),
      `    public async Task<${agg.name}?> GetByIdAsync(${idClass} id, CancellationToken cancellationToken = default)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var r = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = @id${andFilter(true)}", new { id = id.Value${princSuffix} }, cancellationToken: cancellationToken));`,
      ...(hasContains
        ? [
            "        if (r is null) return null;",
            `        var __one = await HydrateAsync(conn, new List<Row> { r }, cancellationToken);`,
            // contains + reference collections: hydrate the child tables first,
            // then post-set the ref-collection list on the reconstructed root.
            ...(hasAssoc ? ["        await LoadRefsAsync(conn, __one, cancellationToken);"] : []),
            "        return __one[0];",
          ]
        : hasAssoc
          ? [
              "        if (r is null) return null;",
              "        var __one = new List<" + agg.name + "> { Map(r) };",
              "        await LoadRefsAsync(conn, __one, cancellationToken);",
              "        return __one[0];",
            ]
          : ["        return r is null ? null : Map(r);"]),
      "    }",
      "",
      ...writeScopeMethod,
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${idClass}> ids, CancellationToken cancellationToken = default)`,
      "    {",
      "        if (ids.Count == 0) return Array.Empty<" + agg.name + ">();",
      `        await using var conn = await _db.OpenConnectionAsync(cancellationToken);`,
      `        var rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT ${colList} FROM ${table} WHERE id = ANY(@ids)${andFilter(true)}", new { ids = ids.Select(x => x.Value).ToArray()${princSuffix} }, cancellationToken: cancellationToken));`,
      ...(hasContains
        ? hasAssoc
          ? [
              "        var __roots = await HydrateAsync(conn, rows.ToList(), cancellationToken);",
              "        await LoadRefsAsync(conn, __roots, cancellationToken);",
              "        return __roots;",
            ]
          : ["        return await HydrateAsync(conn, rows.ToList(), cancellationToken);"]
        : hasAssoc
          ? [
              "        var __roots = rows.Select(Map).ToList();",
              "        await LoadRefsAsync(conn, __roots, cancellationToken);",
              "        return __roots;",
            ]
          : ["        return rows.Select(Map).ToList();"]),
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      ...stampLines,
      ...saveUpsertLines,
      ...assocSaveLines,
      ...containSaveLines,
      ...provFlushLines,
      ...auditFlushLines,
      // Transactional outbox (dispatch-delivery-semantics.md §1): the durable
      // events' __loom_outbox rows are INSERTed on `__tx` — the same
      // transaction the write set rides — so the commit below records them
      // atomically with the state change.  Inserting from DispatchAsync AFTER
      // the commit, on its own pooled connection, loses an owed event to a
      // crash in between.  `__deferred` is what
      // still needs dispatching post-commit (everything, when no durable
      // channel is wired).
      "        var __pending = aggregate.PullEvents();",
      "        var __deferred = await _events.RecordDurableAsync(__pending, __tx, cancellationToken);",
      // Commit the write set atomically before events fire — a rolled-back save
      // (concurrency conflict throw, mid-replace crash) must not dispatch events.
      "        await __tx.CommitAsync(cancellationToken);",
      "        foreach (var ev in __deferred)",
      "        {",
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      deleteMethod ? "" : null,
      deleteMethod || null,
      loadRefsMethod ? "" : null,
      loadRefsMethod || null,
      ...(hasContains ? ["", ...containMembers] : []),
      ...findMethods.flatMap((m) => ["", m]),
      ...retrievalMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Document-shaped (`shape: document`) Dapper repository (D-DOCUMENT-AXIS,
// Dapper edition).  The whole aggregate read model persists as ONE JSONB
// `data` column keyed by `id` (plus a `version` concurrency column) — no
// normalised table-per-entity tree, no join tables: contained parts fold into
// the document (nested snapshots) and `X id[]` references ride along as id
// values in the JSON.  This is the raw-Npgsql mirror of the EF document
// repository (`renderDocumentRepositoryImpl`): the persistence-agnostic
// `ToSnapshot()` / `FromSnapshot(...)` round-trip on the domain entity (emitted
// under `isDoc`) is reused as-is; only the DbContext is swapped for direct
// Npgsql commands.  Finds run in-memory over the rehydrated documents (the same
// LINQ-over-objects fold the EF document path uses).
// ---------------------------------------------------------------------------
export function renderDapperDocumentRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{ name: string; filterClause: string; projectionClause: string }>,
): string {
  const table = sqlIdent(tableOf(agg.name));
  const snap = `${agg.name}Snapshot`;
  const idCs = idTypes(agg.idValueType).cs;
  const versioned = aggregateIsVersioned(agg);
  const finds = (repo?.finds ?? []).map((raw) => unionFindAsOptionalTwin(raw, agg.name));
  const anyFindUsesUser = finds.some(findUsesCurrentUser);
  // Rehydrate from the JSONB snapshot, but the `version` COLUMN is the
  // authoritative concurrency version (INSERT stamps it `1`, ON CONFLICT bumps
  // it) — the snapshot's own `version` field is stale (serialized from the
  // pre-persist aggregate, so `0` on first write).  Overriding it with
  // `__d.version` on read mirrors the relational Dapper repo's `Version =
  // r.version` hydration; without it a loaded aggregate carries version `0`,
  // its next Save sends `ExpectedVersion = 0`, the CAS `WHERE version = 0`
  // misses the row (column is `1`), and every second write 409s.
  const deserSnap = versioned
    ? `System.Text.Json.JsonSerializer.Deserialize<${snap}>(__d.data, __json)! with { Version = __d.version }`
    : `System.Text.Json.JsonSerializer.Deserialize<${snap}>(__d.data, __json)!`;
  const deser = `${agg.name}.FromSnapshot(${deserSnap})`;

  // Audit staging seam — shared with the relational + event-sourced emitters.
  // An audited document aggregate opens a transaction here (the un-audited emit
  // is a single un-transacted upsert and stays byte-identical), so the drained
  // audit rows commit with the snapshot write.
  const audit = dapperAuditSeam(agg, ns);

  // Capability read filter + write-scope narrowing, the Dapper twins of the EF
  // document repository's (`renderDocumentRepositoryImpl`).  A document
  // aggregate is ONE opaque jsonb column, so the filtered fields (`tenantId`,
  // `dataKey`, `isDeleted`) have no column for a WHERE fragment to name — the
  // predicate runs IN-APP over the rehydrated instance instead, exactly as the
  // EF document path (and node/java/python) do.  Both were simply MISSING here:
  // the read filter silently, so a `tenantOwned` document aggregate read across
  // tenants under `persistence: dapper`; the write-scope member loudly, as
  // CS0535 (the interface declares `GetByIdForWriteAsync` whenever the
  // aggregate carries a `writeScopeFilter`).  #2599 pinned the compile half.
  //
  // Hoisted into private statics rather than inlined for the same two reasons
  // the EF twin gives: the read paths must not drift, and a `deny` ladder
  // renders the constant `false` — inlined that makes the next statement
  // unreachable (CS0162 → an error under /warnaserror), while `=> false;` as a
  // method body is clean.
  const capPredicate =
    (agg.contextFilters ?? []).length > 0
      ? (agg.contextFilters ?? [])
          .map(
            (p) =>
              `(${renderCsExpr(p, { thisName: "x", agg, currentUserExpr: AMBIENT_CURRENT_USER })})`,
          )
          .join(" && ")
      : null;
  const capFilter = capPredicate ? ".Where(_CapabilityVisible)" : "";
  const capMethod = capPredicate
    ? [
        "",
        "    /// <summary>Capability read filter (shape: document) — evaluated in-app over the",
        "    /// rehydrated aggregate, since the filtered fields live inside the jsonb blob.</summary>",
        `    private static bool _CapabilityVisible(${agg.name} x) => ${capPredicate};`,
      ]
    : [];
  const writeScopeMethod = agg.writeScopeFilter
    ? [
        "",
        `    public async Task<${agg.name}?> GetByIdForWriteAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
        "    {",
        "        var __found = await GetByIdAsync(id, cancellationToken);",
        "        if (__found == null) return null;",
        "        return _WriteScopeAllows(__found) ? __found : null;",
        "    }",
        "",
        `    private static bool _WriteScopeAllows(${agg.name} x) => ${renderCsExpr(
          agg.writeScopeFilter,
          { thisName: "x", agg, currentUserExpr: AMBIENT_CURRENT_USER },
        )};`,
      ]
    : [];

  // SaveAsync upsert — CAS-guarded on `version` when the aggregate is
  // `versioned` (the same optimistic-concurrency shape the relational Dapper
  // repository uses), a blind version-bumping upsert otherwise.
  const saveLines = versioned
    ? [
        "        var __data = System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json);",
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        audit.begin,
        "        var __expected = RequestContext.Current?.ExpectedVersion ?? aggregate.Version;",
        `        var __affected = await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (id, data, version) VALUES (@id, CAST(@data AS jsonb), 1) ON CONFLICT (id) DO UPDATE SET data = excluded.data, version = ${table}.version + 1 WHERE ${table}.version = @ExpectedVersion", new { id = aggregate.Id.Value, data = __data, ExpectedVersion = __expected }, ${audit.txArg}cancellationToken: cancellationToken));`,
        `        if (__affected == 0) throw new ConcurrencyConflictException("The resource was modified by another request; reload and retry.");`,
        ...audit.flush,
        audit.commit,
      ].filter((l): l is string => l !== null)
    : [
        "        var __data = System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json);",
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        audit.begin,
        `        await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (id, data, version) VALUES (@id, CAST(@data AS jsonb), 1) ON CONFLICT (id) DO UPDATE SET data = excluded.data, version = ${table}.version + 1", new { id = aggregate.Id.Value, data = __data }, ${audit.txArg}cancellationToken: cancellationToken));`,
        ...audit.flush,
        audit.commit,
      ].filter((l): l is string => l !== null);

  const findMethods = finds.map((f) => {
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    // De-async the EF terminal — finds run in-memory over the rehydrated
    // documents, so the async EF operators become their LINQ-to-objects twins.
    const projection = (body?.projectionClause ?? ".ToListAsync(cancellationToken)")
      .replace(".ToListAsync(cancellationToken)", ".ToList()")
      .replace(".FirstOrDefaultAsync(cancellationToken)", ".FirstOrDefault()");
    const usesUser = findUsesCurrentUser(f);
    return lines(
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParams(f.params, [], usesUser)})`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT id, data, version FROM ${table}", cancellationToken: cancellationToken));`,
      // The capability filter narrows the visible set BEFORE the find's own
      // predicate runs, so a find never returns a capability-hidden (foreign
      // tenant, soft-deleted) document.
      `        var __all = __rows.Select(__d => ${deser})${capFilter};`,
      `        return __all${filter}${projection};`,
      "    }",
    );
  });

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `    public async Task DeleteAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
        "    {",
        "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
        // A `destroy audited` stages its row before the delete, so both ride one
        // transaction; the un-audited emit stays a single un-transacted DELETE.
        audit.begin,
        `        await conn.ExecuteAsync(new CommandDefinition("DELETE FROM ${table} WHERE id = @id", new { id = aggregate.Id.Value }, ${audit.txArg}cancellationToken: cancellationToken));`,
        ...audit.flush,
        audit.commit,
        "    }",
      )
    : "";

  return (
    lines(
      "// Auto-generated.  Dapper document persistence (persistence: dapper, shape: document).",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Common;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      audit.usingLine,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    private readonly IDomainEventDispatcher _events;",
      audit.field,
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      "",
      `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events${audit.ctorParam})`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      audit.ctorAssign,
      "    }",
      "",
      "    private sealed class Row",
      "    {",
      `        public ${idCs} id { get; set; }${idCs === "string" ? " = default!;" : ""}`,
      "        public string data { get; set; } = default!;",
      "        public int version { get; set; }",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __d = await conn.QuerySingleOrDefaultAsync<Row>(new CommandDefinition("SELECT id, data, version FROM ${table} WHERE id = @id", new { id = id.Value }, cancellationToken: cancellationToken));`,
      // With a capability filter, a row OUTSIDE the caller's scope reads as
      // missing (→ 404), matching what the relational adapter's spliced WHERE
      // does to the same lookup.
      ...(capPredicate
        ? [
            "        if (__d is null) return null;",
            `        var __rec = ${deser};`,
            "        return _CapabilityVisible(__rec) ? __rec : null;",
          ]
        : [`        return __d is null ? null : ${deser};`]),
      "    }",
      ...writeScopeMethod,
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken cancellationToken = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = await conn.QueryAsync<Row>(new CommandDefinition("SELECT id, data, version FROM ${table} WHERE id = ANY(@ids)", new { ids = ids.Select(x => x.Value).ToArray() }, cancellationToken: cancellationToken));`,
      `        return __rows.Select(__d => ${deser})${capFilter}.ToList();`,
      "    }",
      ...capMethod,
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      ...saveLines,
      "        foreach (var ev in aggregate.PullEvents())",
      "        {",
      "            await _events.DispatchAsync(ev, cancellationToken);",
      "        }",
      "    }",
      deleteMethod ? "" : null,
      deleteMethod || null,
      ...findMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs: eventLog`) Dapper repository (appliers, Dapper
// edition).  The .NET domain layer's fold (`_Apply` / `_FromEvents`) and the
// CQRS create chain are persistence-agnostic and reused as-is; this is the raw
// Npgsql/Dapper version of the event store — read the `<agg>_events` stream
// ordered by version and fold via `_FromEvents`; append `PullEvents()` with
// gap-free versions; finds load every stream + fold in-memory.  Event payloads
// round-trip through System.Text.Json (`RowToEvent` type-switch deserialiser).
// ---------------------------------------------------------------------------
export function renderDapperEventSourcedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  findBodies: Array<{ name: string; filterClause: string; projectionClause: string }>,
  /** The owning bounded context's name — the per-context event log lives in
   *  `<ctx>_events` (event-log-architecture.md), shared by every stream in the
   *  context and discriminated by `stream_type`. */
  ctxName: string,
): string {
  // The single per-context event log (event-log-architecture.md): every load /
  // append / fold scopes to `stream_type = @st` (this aggregate's name) so a
  // sibling stream sharing the `<ctx>_events` table is never folded in.
  const table = `${snake(ctxName)}_events`;
  const streamType = agg.name;
  // Audit staging seam — shared with the relational + document emitters.
  const audit = dapperAuditSeam(agg, ns);
  const eventNames = [...new Set((agg.appliers ?? []).map((a) => a.event))];
  const idValue = csValueTypeForId(agg.idValueType);
  const parseId =
    idValue === "Guid"
      ? "System.Guid.Parse(__g.Key)"
      : idValue === "int"
        ? "int.Parse(__g.Key)"
        : idValue === "long"
          ? "long.Parse(__g.Key)"
          : "__g.Key";
  const rowToEventArms = eventNames.map(
    (e) =>
      `            "${e}" => System.Text.Json.JsonSerializer.Deserialize<${e}>(__r.data, __json)!,`,
  );
  // A `currentUser`-referencing find takes the trailing `User currentUser`
  // param the INTERFACE declares (emit/repository.ts) — the relational and
  // document Dapper repos both thread it, and so must this one — dropping it
  // fails to implement the class's own interface (CS0535) and leaves the
  // body's `currentUser` bound to nothing (CS0103).  `User` is a named type, so
  // the
  // file also needs `using <ns>.Auth`.
  const anyFindUsesUser = (repo?.finds ?? []).some((raw) =>
    findUsesCurrentUser(unionFindAsOptionalTwin(raw, agg.name)),
  );
  // Write-scope narrowing (authorization Phase 3 P3.1): the EVENT-SOURCED twin
  // of the document `writeScopeMethod` above — a stream has no queryable row to
  // pre-guard in SQL, so fold it through `GetByIdAsync` and apply the scope
  // predicate in-app.  Without it, a narrowed write ladder (or `policy { deny
  // write on X }`) on an event-sourced aggregate failed CS0535: the port
  // declares `GetByIdForWriteAsync` whenever `agg.writeScopeFilter` is set.
  const writeScopeMethod = agg.writeScopeFilter
    ? [
        "",
        `    public async Task<${agg.name}?> GetByIdForWriteAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
        "    {",
        "        var __found = await GetByIdAsync(id, cancellationToken);",
        "        if (__found == null) return null;",
        "        return _WriteScopeAllows(__found) ? __found : null;",
        "    }",
        "",
        `    private static bool _WriteScopeAllows(${agg.name} x) => ${renderCsExpr(
          agg.writeScopeFilter,
          { thisName: "x", agg, currentUserExpr: AMBIENT_CURRENT_USER },
        )};`,
      ]
    : [];
  const findMethods = (repo?.finds ?? []).flatMap((raw) => {
    const f = unionFindAsOptionalTwin(raw, agg.name);
    const body = findBodies.find((b) => b.name === f.name);
    const filter = body?.filterClause ?? "";
    // ES finds load every stream in-memory, so strip the async EF terminal
    // (the projection clause is built with `cancellationToken`).
    const projection = (body?.projectionClause ?? ".ToListAsync(cancellationToken)")
      .replace(".ToListAsync(cancellationToken)", ".ToList()")
      .replace(".FirstOrDefaultAsync(cancellationToken)", ".FirstOrDefault()");
    return [
      `    public async Task<${renderCsType(f.returnType)}> ${upperFirst(f.name)}(${renderParams(f.params, [], findUsesCurrentUser(f))})`,
      "    {",
      "        var __all = await _LoadAllAsync(cancellationToken);",
      `        return __all${filter}${projection};`,
      "    }",
    ];
  });
  return (
    lines(
      "// Auto-generated.  Dapper event-store (persistence: dapper, persistedAs: eventLog).",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      `using ${ns}.Domain.${plural(agg.name)};`,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Common;`,
      `using ${ns}.Domain.Events;`,
      anyFindUsesUser ? `using ${ns}.Auth;` : null,
      audit.usingLine,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${agg.name}Repository : I${agg.name}Repository`,
      "{",
      "    private readonly NpgsqlDataSource _db;",
      "    private readonly IDomainEventDispatcher _events;",
      audit.field,
      "    private static readonly System.Text.Json.JsonSerializerOptions __json =",
      "        new(System.Text.Json.JsonSerializerDefaults.Web);",
      "",
      `    public ${agg.name}Repository(NpgsqlDataSource db, IDomainEventDispatcher events${audit.ctorParam})`,
      "    {",
      "        _db = db;",
      "        _events = events;",
      audit.ctorAssign,
      "    }",
      "",
      "    private sealed class EvRow",
      "    {",
      "        public string stream_id { get; set; } = default!;",
      "        public string type { get; set; } = default!;",
      "        public string data { get; set; } = default!;",
      "    }",
      "",
      `    public async Task<${agg.name}?> GetByIdAsync(${agg.name}Id id, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __sid = id.Value.ToString();",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = (await conn.QueryAsync<EvRow>(new CommandDefinition("SELECT stream_id, type, data FROM ${table} WHERE stream_type = @st AND stream_id = @sid ORDER BY version", new { st = "${streamType}", sid = __sid }, cancellationToken: cancellationToken))).ToList();`,
      "        if (__rows.Count == 0) return null;",
      `        return ${agg.name}._FromEvents(id, __rows.Select(RowToEvent).ToList());`,
      "    }",
      ...writeScopeMethod,
      "",
      `    public async Task<IReadOnlyList<${agg.name}>> FindManyByIdsAsync(IReadOnlyList<${agg.name}Id> ids, CancellationToken cancellationToken = default)`,
      "    {",
      `        if (ids.Count == 0) return Array.Empty<${agg.name}>();`,
      `        var __out = new List<${agg.name}>();`,
      "        foreach (var __id in ids)",
      "        {",
      "            var __a = await GetByIdAsync(__id, cancellationToken);",
      "            if (__a != null) __out.Add(__a);",
      "        }",
      "        return __out;",
      "    }",
      "",
      `    public async Task SaveAsync(${agg.name} aggregate, CancellationToken cancellationToken = default)`,
      "    {",
      "        var __pending = aggregate.PullEvents();",
      // Audited: the connection + transaction are hoisted out of the append
      // block, because the staged audit row must be drained and committed even
      // on a save that appends no events.  Un-audited keeps `conn` scoped
      // inside the block, byte-identical to the pre-audit emit.
      audit.on
        ? "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);"
        : null,
      audit.begin,
      "        if (__pending.Count > 0)",
      "        {",
      "            var __sid = aggregate.Id.Value.ToString();",
      audit.on
        ? null
        : "            await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `            var __version = await conn.ExecuteScalarAsync<int?>(new CommandDefinition("SELECT MAX(version) FROM ${table} WHERE stream_type = @st AND stream_id = @sid", new { st = "${streamType}", sid = __sid }, ${audit.txArg}cancellationToken: cancellationToken)) ?? 0;`,
      "            foreach (var __ev in __pending)",
      "            {",
      "                __version++;",
      "                var __data = System.Text.Json.JsonSerializer.Serialize((object)__ev, __json);",
      `                await conn.ExecuteAsync(new CommandDefinition("INSERT INTO ${table} (stream_type, stream_id, version, type, data, occurred_at) VALUES (@st, @sid, @version, @type, CAST(@data AS jsonb), now())", new { st = "${streamType}", sid = __sid, version = __version, type = __ev.GetType().Name, data = __data }, ${audit.txArg}cancellationToken: cancellationToken));`,
      "            }",
      "        }",
      ...audit.flush,
      audit.commit,
      "        foreach (var ev in __pending) await _events.DispatchAsync(ev, cancellationToken);",
      "    }",
      "",
      `    private async Task<List<${agg.name}>> _LoadAllAsync(CancellationToken cancellationToken)`,
      "    {",
      "        await using var conn = await _db.OpenConnectionAsync(cancellationToken);",
      `        var __rows = (await conn.QueryAsync<EvRow>(new CommandDefinition("SELECT stream_id, type, data FROM ${table} WHERE stream_type = @st ORDER BY stream_id, version", new { st = "${streamType}" }, cancellationToken: cancellationToken))).ToList();`,
      `        return __rows`,
      "            .GroupBy(__r => __r.stream_id)",
      `            .Select(__g => ${agg.name}._FromEvents(new ${agg.name}Id(${parseId}), __g.Select(RowToEvent).ToList()))`,
      "            .ToList();",
      "    }",
      "",
      "    private static IDomainEvent RowToEvent(EvRow __r)",
      "    {",
      "        return __r.type switch",
      "        {",
      ...rowToEventArms,
      '            _ => throw new InvalidOperationException($"Unknown event type: {__r.type}"),',
      "        };",
      "    }",
      ...findMethods.flatMap((m) => ["", m]),
      "}",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// schema.sql bootstrap — a self-applied `CREATE TABLE IF NOT EXISTS` per
// aggregate, embedded in a C# helper run once at startup.
// ---------------------------------------------------------------------------

export function renderDapperSchema(
  aggs: readonly EnrichedAggregateIR[],
  ns: string,
  /** Snake-case names of the bounded contexts that own any event-sourced
   *  stream — one shared `<ctx>_events` log per context (event-log-architecture.md),
   *  holding every `persistedAs: eventLog` aggregate stream discriminated by
   *  `stream_type`.  Empty ⇒ no event log. */
  eventLogContexts: readonly string[] = [],
  /** Names of `shape: document` aggregates — each persists as ONE `(id, data
   *  jsonb, version)` table (the whole read model in the JSONB `data` column,
   *  no normalised child/join tables) instead of the flat relational shape. */
  documentAggNames: ReadonlySet<string> = new Set(),
  /** Names of `shape: embedded` aggregates — flat root columns PLUS one JSONB
   *  column per containment (the part sub-graph folds into it), no child tables. */
  embeddedAggNames: ReadonlySet<string> = new Set(),
  /** Extra `CREATE TABLE` statements (M-T6.9): the workflow saga-state,
   *  projection read-model, and __loom_outbox tables the Dapper workflow
   *  surface needs (the raw-Npgsql siblings of the EF-migration-owned tables).
   *  Appended after the aggregate / event-log / provenance tables. */
  extraTables: readonly string[] = [],
  /** The shared `provenance_records` companion table, taken straight off the
   *  MigrationsIR snapshot (`provenanceTableShape`) — the Dapper path emits no
   *  migration files, so this bootstrap is the only thing that creates it, but
   *  it renders the SHARED shape rather than a hand-written mirror.  Undefined
   *  when the served module declares no provenanced field, or when another
   *  deployable owns this module's migrations (that owner's migration creates
   *  the table). */
  provenanceHistoryTable?: TableShape,
): string {
  // Event-sourced aggregates own no per-aggregate table — their stream lives in
  // the shared per-context `<ctx>_events` log emitted after this map.  Document
  // aggregates own one `(id, data, version)` blob table.  A TPC (`ownTable`)
  // ABSTRACT base owns no table of its own (its rows live in each concrete's
  // standalone table with the merged base fields), so it emits no DDL — but a
  // TPH (`sharedTable`) ABSTRACT base DOES own the single shared table (`id` +
  // `kind` discriminator + base columns + the nullable UNION of every concrete's
  // own columns), and each TPH CONCRETE owns no table of its own.
  // One join table per reference collection (`X id[]`).  `X id[]` is a set
  // (membership only, no order): the composite (owner, target) PK is the whole
  // row — no payload column.  No FK constraint (the ownerFk stores the shared
  // base row id for a TPH concrete, whose table is the base's), so reads ORDER
  // BY the target FK id.
  const joinTablesFor = (agg: EnrichedAggregateIR): string[] =>
    (agg.associations ?? []).map((a) =>
      [
        `CREATE TABLE IF NOT EXISTS ${sqlIdent(a.joinTable)} (`,
        `    ${sqlIdent(a.ownerFk)} ${idTypes(agg.idValueType).sql} not null,`,
        `    ${sqlIdent(a.targetFk)} ${idTypes(a.valueType).sql} not null,`,
        `    primary key (${sqlIdent(a.ownerFk)}, ${sqlIdent(a.targetFk)})`,
        ");",
      ].join("\n"),
    );
  // One child table per nested containment (`contains lineItems: LineItem[]`):
  // `id` PK + `<owner>_id` FK (indexed) + the part's own scalar/enum/vo/id
  // columns.  `flattenParts` walks the WHOLE containment tree, so a part-in-part
  // grandchild gets its own table FK'd to its DIRECT parent part (`pc.fkOwner`);
  // a TPH concrete's root parts FK the shared base table (`ownerName`).
  // Cascade-delete keeps the raw-SQL delete path trivial.
  const childTablesFor = (agg: EnrichedAggregateIR, ownerName: string): string[] =>
    flattenParts(partChildrenOf(agg, ownerName)).map((pc) => {
      const fieldCols = pc.fieldCols.map(
        (c) => `    ${sqlIdent(c.col)} ${c.sql}${c.nullable ? "" : " not null"}`,
      );
      return [
        `CREATE TABLE IF NOT EXISTS ${sqlIdent(pc.table)} (`,
        [
          `    id ${pc.partIdSql} primary key`,
          `    ${sqlIdent(pc.parentFk)} ${pc.parentIdSql} not null references ${sqlIdent(plural(snake(pc.fkOwner)))} (id) on delete cascade`,
          ...fieldCols,
        ].join(",\n"),
        ");",
        `CREATE INDEX IF NOT EXISTS ${pc.table}_${pc.parentFk}_idx ON ${sqlIdent(pc.table)} (${sqlIdent(pc.parentFk)});`,
      ].join("\n");
    });

  const stateTables = aggs.flatMap((agg): string[] => {
    if (agg.persistedAs === "eventLog") return [];
    // TPH concrete: no state table of its own (its rows live in the shared base
    // table), but its contained parts + `X id[]` reference collections DO need
    // their tables — child tables FK the shared base row (EF's TPT-via-contains),
    // join tables carry the base row id.
    if (isTphConcrete(agg, aggs)) {
      const base = tableOwnerName(agg, aggs);
      return [...childTablesFor(agg, base), ...joinTablesFor(agg)];
    }
    // TPH shared table: `id` + `kind` + base columns + the nullable union of
    // every concrete's own columns.  A concrete row leaves the sibling
    // concretes' columns NULL (hence nullable); the `kind` discriminator picks
    // the concrete on read (the repo splices `kind = '<Concrete>'`).  A TPC
    // (`ownTable`) abstract base owns nothing.
    if (agg.isAbstract) {
      if (!isTphBase(agg, aggs)) return [];
      const baseCols = columnsOf(agg); // id + base own fields (+version)
      const seen = new Set(baseCols.map((c) => c.col));
      const unionCols: DapperColumn[] = [];
      for (const concrete of tphConcretesOf(agg, aggs)) {
        for (const f of ownFieldsOf(concrete, agg)) {
          const c = fieldColumn(f);
          if (seen.has(c.col)) continue;
          seen.add(c.col);
          // A sibling concrete's column is absent on other kinds → nullable.
          unionCols.push({ ...c, nullable: true });
        }
      }
      const ddlCols = [
        `    ${baseCols[0]!.col} ${baseCols[0]!.sql} primary key`,
        "    kind text not null",
        ...baseCols
          .slice(1)
          .map((c) => `    ${sqlIdent(c.col)} ${c.sql}${c.nullable ? "" : " not null"}`),
        ...unionCols.map((c) => `    ${sqlIdent(c.col)} ${c.sql}`),
      ];
      const shared = `CREATE TABLE IF NOT EXISTS ${sqlIdent(tableOf(agg.name))} (\n${ddlCols.join(",\n")}\n);`;
      // A TPH base may itself declare `contains` / `X id[]` — its own child /
      // join tables FK the shared table (owner = the base).
      return [shared, ...childTablesFor(agg, agg.name), ...joinTablesFor(agg)];
    }
    // Document shape: the whole aggregate is one JSONB `data` column.  No
    // per-field columns, no child/join tables — the graph folds into the blob.
    if (documentAggNames.has(agg.name)) {
      return [
        [
          `CREATE TABLE IF NOT EXISTS ${sqlIdent(tableOf(agg.name))} (`,
          `    id ${idTypes(agg.idValueType).sql} primary key,`,
          "    data jsonb not null,",
          "    version int not null",
          ");",
        ].join("\n"),
      ];
    }
    // Embedded shape: flat root columns + one JSONB containment column each
    // (folded into `columnsOf(agg, true)`), and NO child tables.
    const embedded = embeddedAggNames.has(agg.name);
    const cols = columnsOf(agg, embedded).map((c, i) => {
      const pk = i === 0 ? " primary key" : "";
      const nn = c.nullable || i === 0 ? "" : " not null";
      return `    ${sqlIdent(c.col)} ${c.sql}${pk}${nn}`;
    });
    const root = `CREATE TABLE IF NOT EXISTS ${sqlIdent(tableOf(agg.name))} (\n${cols.join(",\n")}\n);`;
    return [root, ...joinTablesFor(agg), ...(embedded ? [] : childTablesFor(agg, agg.name))];
  });
  // The single per-context event log `<ctx>_events` (event-log-architecture.md):
  // seq cursor + stream_type discriminator + PK (stream_type, stream_id,
  // version) + unique seq index — mirrors the canonical migration.
  const eventLogTables = eventLogContexts.map((ctxSnake) => {
    const t = `${ctxSnake}_events`;
    return [
      `CREATE TABLE IF NOT EXISTS ${t} (`,
      "    seq bigserial not null,",
      "    stream_type text not null,",
      "    stream_id text not null,",
      "    version int not null,",
      "    type text not null,",
      "    data jsonb not null,",
      "    occurred_at timestamptz not null default now(),",
      "    primary key (stream_type, stream_id, version)",
      ");",
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_seq_key ON ${t} (seq);`,
    ].join("\n");
  });
  // The append-only provenance history table (provenance.md), rendered from
  // the SHARED MigrationsIR shape (`provenanceTableShape`) rather than a
  // hand-written CREATE TABLE.  It reaches this emitter as DATA off the
  // snapshot, not as an import (generator may not import system).
  // `IF NOT EXISTS` because DbSchema re-runs on every
  // startup, where a migration would run once.  The co-located
  // `<field>_provenance` columns ride on each aggregate's CREATE TABLE via
  // `columnsOf` — that half is per-aggregate and stays here.
  const provenanceTable = provenanceHistoryTable
    ? [renderCreateTableIfNotExists(provenanceHistoryTable)]
    : [];
  // The append-only audit table (audit-and-logging.md) — the Dapper sibling of
  // the EF AuditRecordConfiguration, column-for-column the shape
  // `migrations-builder` derives.  `before`/`after` are NULLABLE: a create has
  // no before-state and a destroy has no after-state.
  const auditTable = aggs.some(aggHasAuditedTarget)
    ? [
        [
          "CREATE TABLE IF NOT EXISTS audit_records (",
          "    audit_id text primary key,",
          "    operation_id text not null,",
          "    action text not null,",
          "    target_type text not null,",
          "    target_id text not null,",
          "    actor jsonb,",
          "    before jsonb,",
          "    after jsonb,",
          "    at timestamptz not null,",
          "    status text not null,",
          "    correlation_id text,",
          "    scope_id text,",
          "    parent_id text",
          ");",
          "CREATE INDEX IF NOT EXISTS audit_records_target_idx ON audit_records (target_type, target_id);",
          "CREATE INDEX IF NOT EXISTS audit_records_correlation_idx ON audit_records (correlation_id);",
        ].join("\n"),
      ]
    : [];
  const ddl = [
    ...stateTables,
    ...eventLogTables,
    ...provenanceTable,
    ...auditTable,
    ...extraTables,
  ].join("\n\n");
  return (
    lines(
      "// Auto-generated.  Dapper schema bootstrap (persistence: dapper).",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "using Dapper;",
      "using Npgsql;",
      "",
      `namespace ${ns}.Infrastructure.Persistence;`,
      "",
      "public static class DbSchema",
      "{",
      '    public const string Sql = @"',
      ddlToVerbatimLiteral(ddl),
      '";',
      "",
      "    public static async Task EnsureAsync(NpgsqlDataSource db, CancellationToken cancellationToken = default)",
      "    {",
      "        await using var conn = await db.OpenConnectionAsync(cancellationToken);",
      "        // One statement per round-trip.  Npgsql runs a multi-statement command",
      "        // through the extended query protocol, which PARSES every statement",
      "        // before executing any — so a `CREATE INDEX` (or FK) referencing a table",
      "        // an earlier statement creates fails to parse (`column ... does not",
      "        // exist`).  Splitting on `;` keeps each DDL statement its own command, so",
      "        // the table exists before the next statement is parsed.  Every emitted",
      "        // statement is `;`-terminated with no inner semicolons.",
      "        foreach (var stmt in Sql.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))",
      "        {",
      "            await conn.ExecuteAsync(new CommandDefinition(stmt, cancellationToken: cancellationToken));",
      "        }",
      "    }",
      "}",
    ) + "\n"
  );
}

/** Dapper `<PackageReference>` rows for the deployable's csproj (replaces the
 *  EF Core package set). */
export const DAPPER_PROJECT_DEPS: readonly string[] = [
  `    <PackageReference Include="Dapper" Version="2.1.79" />`,
  `    <PackageReference Include="Npgsql" Version="10.0.3" />`,
];

/** Program.cs persistence wiring for Dapper — registers the NpgsqlDataSource
 *  (replaces the `AddDbContext` block). */
export function renderDapperConnectionSetup(): readonly string[] {
  return [
    `builder.Services.AddSingleton(Npgsql.NpgsqlDataSource.Create(`,
    `    builder.Configuration.GetConnectionString("Default")!));`,
  ];
}
