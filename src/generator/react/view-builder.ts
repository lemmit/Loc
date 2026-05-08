import type {
  AggregateIR,
  BoundedContextIR,
  TypeIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { camel, humanize as humanizeUtil, plural, snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// View UI emission for the React generator.
//
// Views are surfaced by the backend as `GET /views/<slug>` endpoints
// returning either:
//
//   - the source aggregate's wire shape (shorthand view —
//     `view ActiveOrders = Order where status == Confirmed`)
//   - a custom shape declared in the view block (full-form view —
//     `view OrderSummary { orderId: Id<Order>, ... bind ... }`)
//
// This module turns every view into a generated React table page.
// Two pages per deployable that has at least one view:
//
//   /views                index page — one card per view
//   /views/<slug>          per-view table page
//
// API hooks live in `src/api/views.ts`.  Per-view query hook
// (`use<View>View`) returns a typed list; the table page renders it.
// Shorthand views reuse the source aggregate's existing
// `<Agg>Response` schema; full-form views get their own row schema
// derived from the view's declared `fields`.
//
// Cells that are `Id<X>` link to the matching aggregate's detail page
// when that aggregate also has UI in this deployable.  Skipped when
// the target aggregate isn't part of this deployable's modules.
// ---------------------------------------------------------------------------

export function hasAnyView(contexts: BoundedContextIR[]): boolean {
  return contexts.some((c) => c.views.length > 0);
}

export function allViews(
  contexts: BoundedContextIR[],
): Array<{ view: ViewIR; ctx: BoundedContextIR }> {
  const out: Array<{ view: ViewIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const v of ctx.views) out.push({ view: v, ctx });
  }
  out.sort((a, b) => a.view.name.localeCompare(b.view.name));
  return out;
}

// ---------------------------------------------------------------------------
// API module — Zod schemas + query hooks per view.  One file at
// `src/api/views.ts` aggregating them all.
// ---------------------------------------------------------------------------

export function buildViewsApiModule(contexts: BoundedContextIR[]): string {
  const views = allViews(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useQuery } from "@tanstack/react-query";`);
  lines.push(`import { api } from "./client";`);
  // Shorthand views reference the source aggregate's response
  // schema from the per-aggregate api module; collect those imports
  // first.
  const shorthandSources = new Set<string>();
  for (const { view } of views) {
    if (!view.output) shorthandSources.add(view.aggregateName);
  }
  for (const aggName of [...shorthandSources].sort()) {
    lines.push(
      `import { ${aggName}Response, ${aggName}ListResponse } from "./${camel(aggName)}";`,
    );
  }
  // Full-form views need enum / VO schemas referenced in their
  // declared row fields.
  const enumDeps = collectEnumDeps(views);
  const voDeps = collectVoDeps(views);
  for (const dep of [...enumDeps, ...voDeps]) {
    lines.push(
      `import { ${dep.schemaName} } from "./${camel(dep.fromAggregate)}";`,
    );
  }
  lines.push("");

  for (const { view } of views) {
    const slug = snake(view.name);
    if (view.output) {
      // Custom shape — emit the row schema + array response.
      lines.push(`export const ${cap(view.name)}Row = z.object({`);
      for (const f of view.output.fields) {
        lines.push(`  ${f.name}: ${zodForResponse(f.type, f.optional)},`);
      }
      lines.push(`});`);
      lines.push(
        `export type ${cap(view.name)}Row = z.infer<typeof ${cap(view.name)}Row>;`,
      );
      lines.push(
        `export const ${cap(view.name)}Response = z.array(${cap(view.name)}Row);`,
      );
      lines.push(
        `export type ${cap(view.name)}Response = z.infer<typeof ${cap(view.name)}Response>;`,
      );
    } else {
      // Shorthand — reuses the source aggregate's list response.
      lines.push(
        `export const ${cap(view.name)}Response = ${view.aggregateName}ListResponse;`,
      );
      lines.push(
        `export type ${cap(view.name)}Response = z.infer<typeof ${cap(view.name)}Response>;`,
      );
    }
    lines.push("");
    // Query hook.
    lines.push(`export function use${cap(view.name)}View() {`);
    lines.push(`  return useQuery({`);
    lines.push(`    queryKey: ["views", "${slug}"],`);
    lines.push(`    queryFn: async () => {`);
    lines.push(`      const r = await api.get(\`/views/${slug}\`);`);
    lines.push(`      return ${cap(view.name)}Response.parse(r);`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`}`);
    lines.push("");
  }

  return lines.join("\n");
}

interface EnumDep {
  fromAggregate: string;
  schemaName: string;
}
interface VoDep {
  fromAggregate: string;
  schemaName: string;
}

function collectEnumDeps(
  views: Array<{ view: ViewIR; ctx: BoundedContextIR }>,
): EnumDep[] {
  const out = new Map<string, EnumDep>();
  for (const { view, ctx } of views) {
    if (!view.output) continue;
    for (const f of view.output.fields) {
      walkType(f.type, (t) => {
        if (t.kind === "enum") {
          const owner = findFirstAggregateWith(ctx, (typ) =>
            typ.kind === "enum" && typ.name === t.name,
          );
          if (owner && !out.has(t.name)) {
            out.set(t.name, {
              fromAggregate: owner,
              schemaName: `${t.name}Schema`,
            });
          }
        }
      });
    }
  }
  return [...out.values()];
}

function collectVoDeps(
  views: Array<{ view: ViewIR; ctx: BoundedContextIR }>,
): VoDep[] {
  const out = new Map<string, VoDep>();
  for (const { view, ctx } of views) {
    if (!view.output) continue;
    for (const f of view.output.fields) {
      walkType(f.type, (t) => {
        if (t.kind === "valueobject") {
          const owner = findFirstAggregateWith(ctx, (typ) =>
            typ.kind === "valueobject" && typ.name === t.name,
          );
          if (owner && !out.has(t.name)) {
            out.set(t.name, {
              fromAggregate: owner,
              schemaName: `${t.name}Schema`,
            });
          }
        }
      });
    }
  }
  return [...out.values()];
}

function walkType(t: TypeIR, visit: (t: TypeIR) => void): void {
  visit(t);
  if (t.kind === "array") walkType(t.element, visit);
  else if (t.kind === "optional") walkType(t.inner, visit);
}

function findFirstAggregateWith(
  ctx: BoundedContextIR,
  matches: (t: TypeIR) => boolean,
): string | undefined {
  for (const a of ctx.aggregates) {
    let found = false;
    const visit = (t: TypeIR): void => {
      if (found) return;
      if (matches(t)) {
        found = true;
        return;
      }
      if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (found) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

// ---------------------------------------------------------------------------
// Index page — `pages/views/index.tsx`.  Card per view, summarising
// source aggregate (shorthand) or "custom shape" + the row column
// names (full-form).
// ---------------------------------------------------------------------------

export function buildViewsIndexPage(contexts: BoundedContextIR[]): string {
  const views = allViews(contexts);
  const cards = views
    .map(({ view }) => {
      const slug = snake(view.name);
      const human = humanise(view.name);
      const shapeLine = view.output
        ? `          <Text size="sm" c="dimmed">Custom shape: ${view.output.fields.map((f) => f.name).join(", ")}</Text>`
        : `          <Text size="sm" c="dimmed">Source: ${view.aggregateName}</Text>`;
      return `      <Card data-testid="view-card-${slug}">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center">
              <IconLayoutList size={18} stroke={2} color="var(--mantine-color-brand-6)" />
              <Title order={4}>${human}</Title>
            </Group>
            <Button component={Link} to="/views/${slug}" data-testid="view-${slug}-open" variant="light">Open →</Button>
          </Group>
${shapeLine}
        </Stack>
      </Card>`;
    })
    .join("\n");
  return `// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Text, Card, Group, Button, SimpleGrid } from "@mantine/core";
import { IconLayoutList } from "@tabler/icons-react";

export default function ViewsIndex() {
  return (
    <Stack data-testid="views-index" gap="md">
      <Stack gap={2}>
        <Title order={2}>Views</Title>
        <Text c="dimmed">Saved queries.  Pick one to inspect.</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
${cards}
      </SimpleGrid>
    </Stack>
  );
}
`;
}

// ---------------------------------------------------------------------------
// Per-view table page — `pages/views/<slug>.tsx`.  Renders the
// query result as a Mantine `<Table>` with one column per row field.
// `Id<X>` cells link to the aggregate's detail page when that
// aggregate has UI in this deployable.
// ---------------------------------------------------------------------------

export function buildViewTablePage(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): string {
  const slug = snake(view.name);
  const human = humanise(view.name);
  const componentName = `${cap(view.name)}ViewPage`;
  const hookName = `use${cap(view.name)}View`;

  // Determine column set + row type alias name for the table.
  const columns = collectColumns(view, ctx, aggregatesByName);
  const cols = columns
    .map((c) => `                  <Table.Th>${humanizeUtil(c.name)}</Table.Th>`)
    .join("\n");
  const cells = columns
    .map((c) => {
      const path = c.accessPath; // dotted accessor on `row`
      const tid = `view-${slug}-row-\${idx}-${c.name}`;
      if (c.linkTargetSlug) {
        // Id<X> with a known target list page in this deployable.
        return `                    <Table.Td data-testid={\`${tid}\`}><Anchor component={Link} to={\`/${c.linkTargetSlug}/\${row.${path}}\`}><IdValue id={row.${path}} /></Anchor></Table.Td>`;
      }
      if (c.kind === "datetime") {
        return `                    <Table.Td data-testid={\`${tid}\`}><DateTimeValue iso={row.${path}} /></Table.Td>`;
      }
      if (c.kind === "bool") {
        return `                    <Table.Td data-testid={\`${tid}\`}><BoolValue value={row.${path}} /></Table.Td>`;
      }
      if (c.kind === "int" || c.kind === "long") {
        return `                    <Table.Td data-testid={\`${tid}\`} style={{ textAlign: "right" }}><NumberValue value={row.${path}} /></Table.Td>`;
      }
      if (c.kind === "decimal") {
        return `                    <Table.Td data-testid={\`${tid}\`} style={{ textAlign: "right" }}><NumberValue value={row.${path}} decimals={2} /></Table.Td>`;
      }
      if (c.kind === "enum") {
        return `                    <Table.Td data-testid={\`${tid}\`}><Badge tt="unset" variant="light">{row.${path}}</Badge></Table.Td>`;
      }
      if (c.kind === "id") {
        return `                    <Table.Td data-testid={\`${tid}\`}><IdValue id={row.${path}} /></Table.Td>`;
      }
      return `                    <Table.Td data-testid={\`${tid}\`}>{row.${path} === null || row.${path} === undefined || row.${path} === "" ? <EmptyValue /> : String(row.${path})}</Table.Td>`;
    })
    .join("\n");
  return `// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Group, Anchor, Badge, Table, Alert, Text, Paper, Skeleton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { ${hookName} } from "../../api/views";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function ${componentName}() {
  const q = ${hookName}();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="view-${slug}" gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>View</Text>
          <Title order={2}>${human}</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 row" : count + " rows"}</Text>
        </Stack>
        <Anchor component={Link} to="/views">← back</Anchor>
      </Group>
      {q.isLoading && (
        <Paper p="md">
          <Stack gap="xs">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={28} radius="sm" />
            ))}
          </Stack>
        </Paper>
      )}
      {q.isError && <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load view">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && <Text c="dimmed">No rows.</Text>}
      {q.data && q.data.length > 0 && (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
${cols}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row, idx) => (
                  <Table.Tr key={idx} data-testid={\`view-${slug}-row-\${idx}\`}>
${cells}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
}
`;
}

interface Column {
  name: string;
  /** Dotted accessor on `row` — `id`, `customerId`, `unitPrice.amount`. */
  accessPath: string;
  /** Coarse cell-rendering kind — drives which formatter the table
   *  cell uses (id / datetime / bool / int / long / decimal / enum
   *  / string).  Mirrors TypeIR.kind for primitives and matches
   *  "id" / "enum" / "string" for the type's display shape. */
  kind: string;
  /** When the cell is an `Id<X>` referencing an aggregate that has
   *  UI in this deployable, the slug to link to. */
  linkTargetSlug?: string;
}

function collectColumns(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): Column[] {
  const columnKind = (t: TypeIR): string => {
    const inner = unwrapOpt(t);
    if (inner.kind === "primitive") return inner.name;
    return inner.kind;
  };
  if (view.output) {
    // Custom shape — one column per declared row field, primitives only.
    // Value-object fields render via String() of the whole VO; richer
    // rendering can be added when there's a real need.
    return view.output.fields.map((f) => {
      const inner = unwrapOpt(f.type);
      const linkTargetSlug =
        inner.kind === "id" && aggregatesByName.has(inner.targetName)
          ? snake(plural(inner.targetName))
          : undefined;
      return {
        name: f.name,
        accessPath: f.name,
        kind: columnKind(f.type),
        linkTargetSlug,
      };
    });
  }
  // Shorthand — reuses the source aggregate's wire shape.  Show the
  // id + every primitive / id / enum field at the root level.
  const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
  if (!agg)
    return [{ name: "id", accessPath: "id", kind: "string" }];
  const cols: Column[] = [{ name: "id", accessPath: "id", kind: "string" }];
  for (const f of agg.fields) {
    const inner = unwrapOpt(f.type);
    if (
      inner.kind === "primitive" ||
      inner.kind === "enum" ||
      inner.kind === "id"
    ) {
      cols.push({
        name: f.name,
        accessPath: f.name,
        kind: columnKind(f.type),
        linkTargetSlug:
          inner.kind === "id" && aggregatesByName.has(inner.targetName)
            ? snake(plural(inner.targetName))
            : undefined,
      });
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Playwright page object — slice 18.C.  One class per view at
// `e2e/pages/views/<slug>.ts`:
//
//   class <Cap>ViewPage {
//     async goto(): Promise<this>      // navigate, wait for table
//     async rows(): Promise<RowShape[]>  // read every cell back into a typed
//                                          object — drives the table by reading
//                                          `view-<slug>-row-<idx>-<col>` testids
//   }
//
// `RowShape` is the same `<View>Row` type emitted by the api module
// (full-form view) or `<Aggregate>Response` (shorthand view).  All
// values come back as strings (cell .innerText()) — callers `Number()`
// or compare textually as the test asks.
// ---------------------------------------------------------------------------

export function buildViewPageObject(
  view: ViewIR,
  ctx: BoundedContextIR,
): string {
  const slug = snake(view.name);
  const className = `${cap(view.name)}ViewPage`;
  const cols = collectColumnNames(view, ctx);
  // RowShape: declared as a local interface so the page object stays
  // self-contained — referencing the api/views.ts type would tangle
  // the e2e tsconfig with the Vite project's react-jsx setting.
  const rowFields = cols.map((c) => `  ${c}: string;`).join("\n");
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push("");
  lines.push(`export interface ${cap(view.name)}RowText {`);
  lines.push(rowFields);
  lines.push(`}`);
  lines.push("");
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = "/views/${slug}";`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("view-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async rows(): Promise<${cap(view.name)}RowText[]> {`);
  lines.push(`    // Walk row indices until the row testid stops matching.`);
  lines.push(`    // The empty-state branch in the React table renders no`);
  lines.push(`    // rows at all, so the loop terminates immediately.`);
  lines.push(`    const out: ${cap(view.name)}RowText[] = [];`);
  lines.push(`    for (let i = 0; i < 1000; i++) {`);
  lines.push(
    `      const row = this.page.getByTestId(\`view-${slug}-row-\${i}\`);`,
  );
  lines.push(`      if ((await row.count()) === 0) break;`);
  for (const c of cols) {
    lines.push(
      `      const ${camel("c_" + c)} = await this.page.getByTestId(\`view-${slug}-row-\${i}-${c}\`).innerText();`,
    );
  }
  const rowLiteral = cols
    .map((c) => `${c}: ${camel("c_" + c)}`)
    .join(", ");
  lines.push(`      out.push({ ${rowLiteral} });`);
  lines.push(`    }`);
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  /** Count of currently-rendered rows. */`);
  lines.push(`  async count(): Promise<number> {`);
  lines.push(`    return (await this.rows()).length;`);
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function collectColumnNames(view: ViewIR, ctx: BoundedContextIR): string[] {
  if (view.output) return view.output.fields.map((f) => f.name);
  const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
  if (!agg) return ["id"];
  const cols = ["id"];
  for (const f of agg.fields) {
    const inner = unwrapOpt(f.type);
    if (
      inner.kind === "primitive" ||
      inner.kind === "enum" ||
      inner.kind === "id"
    ) {
      cols.push(f.name);
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function humanise(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced[0]!.toUpperCase() + spaced.slice(1);
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
      return "z.unknown()";
    case "array":
      return `z.array(${zodForResponseInner(t.element)})`;
    case "optional":
      return `${zodForResponseInner(t.inner)}.nullish()`;
  }
}
