// OpenAPI schema-id collisions (schemathesis finding F14).
//
// The .NET emitter writes one wire-DTO namespace PER AGGREGATE
// (`Application.<Aggregates>.Requests` / `.Responses`), so a value object used
// by two aggregates produces two CLR types with the same SHORT name —
// `Api.Application.Products.Requests.MoneyRequest` and
// `Api.Application.Orders.Requests.MoneyRequest`.  Swashbuckle's default
// `schemaId` selector is that short name, and a collision is FATAL to the whole
// document: `GET /openapi.json` answers 500 with
// `Can't use schemaId "$MoneyRequest" for type …`, so the deployable publishes
// no contract at all.
//
// The fix is deliberately NARROW.  Namespace-qualifying every schema id would
// close the crash but break component-name parity with the other four backends
// (which publish SHORT names, the shape `.loom/wire-spec.json` and the
// conformance-parity gate compare).  So only the short names that GENUINELY
// collide are qualified, with their own namespace's aggregate segment
// (`ProductsMoneyRequest` / `OrdersMoneyRequest`); a collision-free project
// gets an empty override set and byte-identical output.
//
// The inventory is DERIVED from the emitted files rather than re-walked from
// the IR: the emitted C# is the ground truth for which CLR types exist, so a
// new DTO emitter is covered the day it lands, with nothing to keep in sync.

/** One `CustomSchemaIds` override: the CLR type's full name → the schema id. */
export interface SchemaIdOverride {
  /** `Namespace.TypeName` — matched against `Type.FullName` at runtime. */
  readonly clrFullName: string;
  /** The qualified id to publish instead of the (colliding) short name. */
  readonly schemaId: string;
}

/** File-scoped namespace declaration: `namespace Api.Application.X.Requests;`. */
const NAMESPACE_RE = /^namespace\s+([A-Za-z_][\w.]*)\s*;/m;

/** Top-level `record` declarations.  Records only: EVERY controller-facing DTO
 *  the .NET emitter writes is a record (requests, responses, union carriers,
 *  projection rows) — the `class`es sharing these namespaces are validators,
 *  handlers and controllers, which never become an OpenAPI schema.  Generic
 *  declarations (`Paged<T>`) are skipped too — a closed generic's `FullName` is
 *  the mangled ``Ns.Paged`1[[…]]`` form, and the generic carrier already has
 *  its own `CustomSchemaIds` arm. */
const TYPE_DECL_RE =
  /^\s*public\s+(?:(?:sealed|abstract|partial)\s+)*record\s+(\w+)\s*([<(:;{]?)/gm;

/** Does this namespace hold types a controller signature can expose?  Every
 *  `Application.*` namespace does EXCEPT the `.Commands` / `.Queries` leaves,
 *  which carry internal Mediator messages that never reach the wire.  Being
 *  inclusive here is the safe direction: an override for a type Swashbuckle
 *  never asks about is inert, while a missing one is another 500. */
function isWireDtoNamespace(ns: string): boolean {
  if (!/\.Application\./.test(`${ns}.`)) return false;
  const last = ns.slice(ns.lastIndexOf(".") + 1);
  return last !== "Commands" && last !== "Queries";
}

/** The disambiguating segment for a DTO namespace: the aggregate plural that
 *  owns it (`…Application.Products.Requests` → `Products`), or the leaf itself
 *  when there is no `Requests`/`Responses` suffix (`…Application.Workflows` →
 *  `Workflows`). */
function namespaceQualifier(ns: string): string {
  const segments = ns.split(".");
  const last = segments[segments.length - 1];
  if (segments.length > 1 && (last === "Requests" || last === "Responses")) segments.pop();
  return segments[segments.length - 1];
}

/** Every namespace segment below the project root, flattened — the fallback
 *  qualifier when the aggregate segment alone would collide with another id. */
function flattenedQualifier(ns: string): string {
  return ns.split(".").join("");
}

/**
 * The `CustomSchemaIds` overrides this project needs, derived from its own
 * emitted files.  Empty (the common case) ⇒ `Program.cs` keeps today's exact
 * `return t.Name;` fallback and no dictionary.
 *
 * @param files the project's emitted `path → content` map, DTO files included.
 */
export function dotnetSchemaIdOverrides(files: ReadonlyMap<string, string>): SchemaIdOverride[] {
  // shortName → the wire-DTO namespaces declaring it (deduped, insertion order).
  const byShortName = new Map<string, string[]>();
  for (const [filePath, content] of files) {
    if (!filePath.endsWith(".cs")) continue;
    const ns = NAMESPACE_RE.exec(content)?.[1];
    if (!ns || !isWireDtoNamespace(ns)) continue;
    TYPE_DECL_RE.lastIndex = 0;
    for (let m = TYPE_DECL_RE.exec(content); m !== null; m = TYPE_DECL_RE.exec(content)) {
      if (m[2] === "<") continue; // generic declaration — see TYPE_DECL_RE
      const name = m[1];
      const seen = byShortName.get(name);
      if (!seen) byShortName.set(name, [ns]);
      else if (!seen.includes(ns)) seen.push(ns);
    }
  }
  // Ids already spoken for: every short name that keeps its short id (a
  // qualified id must never shadow one) — the colliding names are re-added
  // below as they are assigned.
  const taken = new Set<string>();
  for (const [name, namespaces] of byShortName) if (namespaces.length === 1) taken.add(name);

  const overrides: SchemaIdOverride[] = [];
  for (const [name, namespaces] of byShortName) {
    if (namespaces.length < 2) continue;
    for (const ns of namespaces) {
      const candidate = `${namespaceQualifier(ns)}${name}`;
      const schemaId = taken.has(candidate) ? `${flattenedQualifier(ns)}${name}` : candidate;
      taken.add(schemaId);
      overrides.push({ clrFullName: `${ns}.${name}`, schemaId });
    }
  }
  // Deterministic order — the emitted dictionary is byte-stable across runs.
  return overrides.sort((a, b) => (a.clrFullName < b.clrFullName ? -1 : 1));
}
