import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  EnumIR,
  RepositoryIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { wireShapeFor } from "../../ir/enrichments.js";
import { plural, snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Per-aggregate API module: Zod schemas + React Query hooks.
//
// The schemas mirror the backend's wire shape exactly (see
// generator/typescript/routes-builder.ts and dotnet/dto-mapping.ts).
// Hooks parse the response with the matching schema before returning,
// so callers get type-checked, validated data — no `as never` casts.
// ---------------------------------------------------------------------------

export function buildApiModule(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(
    `import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";`,
  );
  lines.push(`import { api } from "./client.js";`);
  lines.push("");

  // Schemas — enums + value-objects + per-route DTOs.
  const usedVOs = collectValueObjects(agg, repo, ctx);
  const usedEnums = collectEnums(agg, repo, ctx);

  for (const e of usedEnums) lines.push(...emitEnumSchema(e));
  for (const vo of usedVOs) lines.push(...emitValueObjectSchema(vo));
  lines.push("");

  // Request schemas.
  const requiredFields = agg.fields.filter((f) => !f.optional);
  lines.push(`export const Create${agg.name}Request = z.object({`);
  for (const f of requiredFields) {
    lines.push(`  ${f.name}: ${zodForRequest(f.type)},`);
  }
  lines.push(`});`);
  lines.push(
    `export type Create${agg.name}Request = z.infer<typeof Create${agg.name}Request>;`,
  );
  lines.push("");

  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    lines.push(`export const ${cap(op.name)}Request = z.object({`);
    for (const p of op.params) {
      lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
    }
    lines.push(`});`);
    lines.push(
      `export type ${cap(op.name)}Request = z.infer<typeof ${cap(op.name)}Request>;`,
    );
  }
  lines.push("");

  // Find queries (other than `all`, which has no params).
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      lines.push(`export const ${cap(find.name)}Query = z.object({`);
      for (const p of find.params) {
        lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
      }
      lines.push(`});`);
      lines.push(
        `export type ${cap(find.name)}Query = z.infer<typeof ${cap(find.name)}Query>;`,
      );
    }
  }
  lines.push("");

  // Response schemas.  Inner DTOs must come first so they're declared
  // before the root references them.
  for (const part of agg.parts) {
    lines.push(...emitResponseSchema(part, ctx, /*isAgg*/ false));
  }
  lines.push(...emitResponseSchema(agg, ctx, /*isAgg*/ true));
  lines.push(
    `export const ${agg.name}ListResponse = z.array(${agg.name}Response);`,
  );
  lines.push(
    `export type ${agg.name}ListResponse = z.infer<typeof ${agg.name}ListResponse>;`,
  );
  lines.push("");

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------
  const tag = snake(plural(agg.name));
  const aggKey = `["${tag}"]`;
  const detailKey = `["${tag}", id]`;

  // useAll<Agg>
  lines.push(`export function useAll${plural(agg.name)}() {`);
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: ${aggKey},`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}\`);`);
  lines.push(`      return ${agg.name}ListResponse.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // use<Agg>ById
  lines.push(
    `export function use${agg.name}ById(id: string | undefined) {`,
  );
  lines.push(`  return useQuery({`);
  lines.push(`    queryKey: ${detailKey},`);
  lines.push(`    enabled: !!id,`);
  lines.push(`    queryFn: async () => {`);
  lines.push(`      const r = await api.get(\`/${tag}/\${id}\`);`);
  lines.push(`      return ${agg.name}Response.parse(r);`);
  lines.push(`    },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // useCreate<Agg>
  lines.push(`export function useCreate${agg.name}() {`);
  lines.push(`  const qc = useQueryClient();`);
  lines.push(`  return useMutation({`);
  lines.push(`    mutationFn: async (input: Create${agg.name}Request) => {`);
  lines.push(`      const r = await api.post(\`/${tag}\`, input);`);
  lines.push(
    `      return z.object({ id: z.string() }).parse(r);`,
  );
  lines.push(`    },`);
  lines.push(`    onSuccess: () => qc.invalidateQueries({ queryKey: ${aggKey} }),`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push("");

  // use<Op><Agg> — one per public operation.
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const opSnake = snake(op.name);
    lines.push(
      `export function use${cap(op.name)}${agg.name}(id: string) {`,
    );
    lines.push(`  const qc = useQueryClient();`);
    lines.push(`  return useMutation({`);
    lines.push(
      `    mutationFn: async (input: ${cap(op.name)}Request) => {`,
    );
    lines.push(
      `      await api.post(\`/${tag}/\${id}/${opSnake}\`, input);`,
    );
    lines.push(`    },`);
    lines.push(
      `    onSuccess: () => {`,
    );
    lines.push(`      qc.invalidateQueries({ queryKey: ["${tag}", id] });`);
    lines.push(`      qc.invalidateQueries({ queryKey: ${aggKey} });`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`}`);
    lines.push("");
  }

  // use<FindName> — one per non-`all` find.
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      const findSnake = snake(find.name);
      const isList = find.returnType.kind === "array";
      const responseSchema = isList
        ? `${agg.name}ListResponse`
        : find.returnType.kind === "optional"
          ? `${agg.name}Response.nullable()`
          : `${agg.name}Response`;
      lines.push(
        `export function use${cap(find.name)}${agg.name}(query: ${cap(find.name)}Query) {`,
      );
      lines.push(`  return useQuery({`);
      lines.push(
        `    queryKey: ["${tag}", "find", "${findSnake}", query],`,
      );
      lines.push(`    queryFn: async () => {`);
      lines.push(
        `      const qs = new URLSearchParams(query as Record<string, string>).toString();`,
      );
      lines.push(
        `      const r = await api.get(\`/${tag}/${findSnake}\${qs ? "?" + qs : ""}\`);`,
      );
      lines.push(`      return ${responseSchema}.parse(r);`);
      lines.push(`    },`);
      lines.push(`  });`);
      lines.push(`}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Schema emission helpers
// ---------------------------------------------------------------------------

function emitEnumSchema(e: EnumIR): string[] {
  const values = e.values.map((v) => `"${v}"`).join(", ");
  return [`export const ${e.name}Schema = z.enum([${values}]);`];
}

function emitValueObjectSchema(vo: ValueObjectIR): string[] {
  const lines: string[] = [];
  lines.push(`export const ${vo.name}Schema = z.object({`);
  for (const f of vo.fields) {
    lines.push(`  ${f.name}: ${zodForResponseInner(f.type)},`);
  }
  lines.push(`});`);
  return lines;
}

function emitResponseSchema(
  ent: AggregateIR | EntityPartIR,
  ctx: BoundedContextIR,
  isAgg: boolean,
): string[] {
  const lines: string[] = [];
  const name = `${ent.name}Response`;
  lines.push(`export const ${name} = z.object({`);
  // Single canonical walk — populated by `enrichLoomModel` (see
  // src/ir/enrichments.ts).  Backends + frontend all read the same
  // field list, so Zod schemas line up field-for-field with what
  // the wire actually carries.
  const fields = wireShapeFor(ent);
  void ctx;
  void isAgg;
  for (const wf of fields) {
    if (wf.source === "id") {
      lines.push(`  ${wf.name}: z.string(),`);
    } else {
      lines.push(`  ${wf.name}: ${zodForResponse(wf.type, wf.optional)},`);
    }
  }
  lines.push(`});`);
  lines.push(`export type ${name} = z.infer<typeof ${name}>;`);
  return lines;
}

// ---------------------------------------------------------------------------
// Type → Zod helpers
// ---------------------------------------------------------------------------

function zodForRequest(t: TypeIR): string {
  // Form inputs hand back native JS types where Mantine has a typed
  // primitive (number, boolean), and ISO strings for datetime — we
  // use a plain <input type="datetime-local"> so values are easy to
  // fill from Playwright tests.  JSON.stringify passes numbers and
  // strings through untouched.
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodForRequest(t.element)})`;
    case "optional":
      return `${zodForRequest(t.inner)}.nullish()`;
  }
}

function zodForResponse(t: TypeIR, optional: boolean): string {
  const z = zodForResponseInner(t);
  return optional ? `${z}.nullish()` : z;
}

function zodForResponseInner(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum":
      return `${t.name}Schema`;
    case "valueobject":
      return `${t.name}Schema`;
    case "entity":
      return `${t.name}Response`;
    case "array":
      return `z.array(${zodForResponseInner(t.element)})`;
    case "optional":
      return `${zodForResponseInner(t.inner)}.nullish()`;
  }
}

function collectValueObjects(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

function collectEnums(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): EnumIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const f of repo?.finds ?? []) for (const p of f.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.enums.filter((e) => used.has(e.name));
}

function cap(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
