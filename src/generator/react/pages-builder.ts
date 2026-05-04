import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  FieldIR,
  ParamIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Per-aggregate React pages — list, new, detail.
//
// Every interactive element carries a stable `data-testid` derived from the
// aggregate slug + role + field name.  Page objects under e2e/pages/ key off
// these; users writing Playwright tests get reliable selectors without
// brittle text matching.
// ---------------------------------------------------------------------------

export function buildListPage(agg: AggregateIR): string {
  const slug = snake(plural(agg.name));
  const cap = upper(agg.name);
  const cols: string[] = [];
  cols.push(`<Table.Th>id</Table.Th>`);
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) cols.push(`<Table.Th>${f.name}</Table.Th>`);
  }
  const cells: string[] = [];
  cells.push(
    `<Table.Td><Anchor component={Link} to={\`/${slug}/\${row.id}\`} data-testid={\`${slug}-row-\${row.id}-link\`}>{row.id.slice(0, 8)}…</Anchor></Table.Td>`,
  );
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) cells.push(displayCellExpr(slug, f));
  }
  return `// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge } from "@mantine/core";
import { useAll${plural(agg.name)} } from "../../api/${camel(agg.name)}.js";

export default function ${cap}List(): JSX.Element {
  const navigate = useNavigate();
  const q = useAll${plural(agg.name)}();
  return (
    <Stack data-testid="${slug}-list">
      <Group justify="space-between">
        <Title order={2}>${plural(agg.name)}</Title>
        <Button onClick={() => navigate("/${slug}/new")} data-testid="${slug}-list-create">Create ${agg.name.toLowerCase()}</Button>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              ${cols.join("\n              ")}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row) => (
              <Table.Tr key={row.id} data-testid={\`${slug}-row-\${row.id}\`}>
                ${cells.join("\n                ")}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
`;
}

export function buildNewPage(agg: AggregateIR, ctx: BoundedContextIR): string {
  const slug = snake(plural(agg.name));
  const cap = upper(agg.name);
  const fields = agg.fields.filter((f) => !f.optional);
  const formFields = fields
    .map((f) => formInput(f.name, f.type, ctx, `${slug}-new-input-${f.name}`))
    .join("\n        ");
  return `// Auto-generated.
import { useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, TextInput, NumberInput, Switch, Select, Fieldset } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { useForm } from "@mantine/form";
import { zodResolver } from "mantine-form-zod-resolver";
import { Create${agg.name}Request, useCreate${agg.name} } from "../../api/${camel(agg.name)}.js";

export default function ${cap}New(): JSX.Element {
  const navigate = useNavigate();
  const create = useCreate${agg.name}();
  const form = useForm<Create${agg.name}Request>({
    initialValues: ${initialValuesTs(fields, ctx)},
    validate: zodResolver(Create${agg.name}Request),
  });
  return (
    <Stack maw={600} data-testid="${slug}-new">
      <Title order={2}>New ${agg.name.toLowerCase()}</Title>
      <form
        onSubmit={form.onSubmit(async (vals) => {
          try {
            const out = await create.mutateAsync(vals);
            notifications.show({ color: "green", message: "${agg.name} created" });
            navigate(\`/${slug}/\${out.id}\`);
          } catch (e) {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        })}
      >
        <Stack>
        ${formFields}
          <Group justify="flex-end">
            <Button type="submit" loading={create.isPending} data-testid="${slug}-new-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
`;
}

export function buildDetailPage(agg: AggregateIR, ctx: BoundedContextIR): string {
  const slug = snake(plural(agg.name));
  const cap = upper(agg.name);
  const ops = agg.operations.filter((o) => o.visibility === "public");

  const opHookImports = ops
    .map((op) => `use${upper(op.name)}${agg.name}`)
    .join(", ");
  const reqImports = ops
    .map((op) => `${upper(op.name)}Request`)
    .join(", ");

  const fieldDisplay = agg.fields
    .map((f) => fieldDisplayLine(slug, f, ctx))
    .join("\n        ");

  const partsBlocks = agg.contains
    .map((c) => {
      const part = agg.parts.find((p) => p.name === c.partName);
      return part ? renderPartTable(slug, part, c.name, c.collection) : "";
    })
    .filter(Boolean)
    .join("\n        ");

  const opButtons = ops
    .map((op) => renderOperationButton(slug, op))
    .join("\n          ");

  return `// Auto-generated.
import { useParams, useNavigate, Link } from "react-router-dom";
import { Stack, Title, Card, Group, Button, Text, Loader, Alert, Anchor, Badge, Table, Fieldset, TextInput, NumberInput, Switch, Select } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "@mantine/form";
import { zodResolver } from "mantine-form-zod-resolver";
import { use${agg.name}ById${ops.length > 0 ? `, ${opHookImports}` : ""}${reqImports.length > 0 ? `, ${reqImports}` : ""} } from "../../api/${camel(agg.name)}.js";

export default function ${cap}Detail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const q = use${agg.name}ById(id);
${ops.map((op) => `  const ${camel(op.name)} = use${upper(op.name)}${agg.name}(id ?? "");`).join("\n")}
  if (q.isLoading) return <Loader />;
  if (q.isError) return <Alert color="red">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Text>Not found.</Text>;
  const data = q.data;
  return (
    <Stack data-testid="${slug}-detail">
      <Group justify="space-between">
        <Title order={2}>${agg.name} {data.id.slice(0, 8)}…</Title>
        <Anchor component={Link} to="/${slug}">← back</Anchor>
      </Group>
      <Card withBorder>
        <Stack gap="xs">
        ${fieldDisplay}
        </Stack>
      </Card>
      ${partsBlocks}
      ${ops.length > 0
        ? `<Card withBorder>
        <Title order={4}>Operations</Title>
        <Group>
          ${opButtons}
        </Group>
      </Card>`
        : ""}
    </Stack>
  );
}

${ops.map((op) => renderOperationModalFn(slug, agg, op, ctx)).join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// Detail-page helpers
// ---------------------------------------------------------------------------

function fieldDisplayLine(
  slug: string,
  f: FieldIR,
  ctx: BoundedContextIR,
): string {
  const t = unwrapOpt(f.type);
  const tid = `${slug}-detail-${f.name}`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      const inner = vo.fields
        .map(
          (vf) =>
            `${vf.name}: <span data-testid="${tid}-${vf.name}">{String(data.${f.name}.${vf.name})}</span>`,
        )
        .join(", ");
      return `<Text><strong>${f.name}:</strong> ${inner}</Text>`;
    }
  }
  if (t.kind === "enum") {
    // tt="unset" disables Mantine's default uppercasing so the rendered
    // text matches the enum value verbatim — predictable for tests.
    return `<Text><strong>${f.name}:</strong> <Badge tt="unset" data-testid="${tid}">{data.${f.name}}</Badge></Text>`;
  }
  return `<Text><strong>${f.name}:</strong> <span data-testid="${tid}">{String(data.${f.name})}</span></Text>`;
}

function renderPartTable(
  slug: string,
  part: EntityPartIR,
  name: string,
  collection: boolean,
): string {
  if (!collection) {
    return `<Card withBorder><Title order={4}>${name}</Title><Text>{JSON.stringify(data.${name})}</Text></Card>`;
  }
  const cols = ["id", ...part.fields.filter((f) => isPrimitiveLike(f.type)).map((f) => f.name)];
  const partSlug = snake(plural(part.name));
  return `<Card withBorder>
        <Title order={4}>${name}</Title>
        <Table striped withTableBorder data-testid="${slug}-detail-${name}">
          <Table.Thead>
            <Table.Tr>
              ${cols.map((c) => `<Table.Th>${c}</Table.Th>`).join("\n              ")}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.${name}.map((row) => (
              <Table.Tr key={row.id} data-testid={\`${slug}-detail-${name}-row-\${row.id}\`}>
                ${cols
                  .map(
                    (c) =>
                      `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}>{String(row.${c} ?? "")}</Table.Td>`,
                  )
                  .join("\n                ")}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>${voidPart(partSlug)}`;
}

function voidPart(_s: string): string {
  // Ensures partSlug isn't flagged unused; reserved for future per-part
  // page-object generation.
  return "";
}

function renderOperationButton(
  slug: string,
  op: { name: string; params: ParamIR[] },
): string {
  return `<Button onClick={() => open${upper(op.name)}Modal(${camel(op.name)})} data-testid="${slug}-op-${op.name}">${op.name}</Button>`;
}

function renderOperationModalFn(
  slug: string,
  agg: AggregateIR,
  op: { name: string; params: ParamIR[] },
  ctx: BoundedContextIR,
): string {
  const cap = upper(op.name);
  const formFields = op.params.length > 0
    ? op.params
        .map((p) =>
          formInput(p.name, p.type, ctx, `${slug}-op-${op.name}-input-${p.name}`),
        )
        .join("\n        ")
    : `<Text>This operation has no parameters.</Text>`;
  return `function open${cap}Modal(mut: ReturnType<typeof use${cap}${agg.name}>): void {
  modals.open({
    title: "${op.name}",
    children: <${cap}Form mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function ${cap}Form({ mut, onClose }: { mut: ReturnType<typeof use${cap}${agg.name}>; onClose: () => void }): JSX.Element {
  const form = useForm<${cap}Request>({
    initialValues: ${initialValuesTs(op.params.map((p) => ({ name: p.name, type: p.type, optional: false })), ctx)},
    validate: zodResolver(${cap}Request),
  });
  return (
    <form
      data-testid="${slug}-op-${op.name}-form"
      onSubmit={form.onSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "${op.name} succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        ${formFields}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="${slug}-op-${op.name}-submit">${op.name}</Button>
        </Group>
      </Stack>
    </form>
  );
}`;
}

// ---------------------------------------------------------------------------
// Form-input helpers
// ---------------------------------------------------------------------------

function formInput(
  name: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  testId: string,
): string {
  const inner = unwrapOpt(t);
  const props = `label="${name}" {...form.getInputProps("${name}")}`;
  const tid = `data-testid="${testId}"`;
  if (inner.kind === "primitive") {
    if (inner.name === "int" || inner.name === "long") {
      return `<NumberInput ${props} ${tid} allowDecimal={false} />`;
    }
    if (inner.name === "decimal") {
      return `<NumberInput ${props} ${tid} decimalScale={2} fixedDecimalScale />`;
    }
    if (inner.name === "bool") {
      return `<Switch label="${name}" ${tid} checked={!!form.values.${name}} onChange={(e) => form.setFieldValue("${name}", e.currentTarget.checked)} />`;
    }
    if (inner.name === "datetime") {
      // Native datetime-local — Mantine's DateTimePicker isn't a plain
      // input and resists Playwright's `.fill()`.  Native input keeps
      // the form bulletproof for tests; users can swap to Mantine via
      // .loomignore for a richer UX.
      return `<TextInput ${props} ${tid} type="datetime-local" />`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "id") {
    return `<TextInput ${props} ${tid} placeholder="<id>" />`;
  }
  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    if (en) {
      // Mantine <Select> calls onChange with (value, option) rather
      // than a DOM event, so getInputProps' event-based onChange never
      // fires.  Bind value/onChange/error explicitly — the pattern
      // @mantine/form recommends for components without event-based
      // onChange.  `allowDeselect={false}` keeps a click on the already-
      // selected option from clearing the field, which matters for
      // required fields and makes Playwright tests deterministic.
      const data = JSON.stringify(en.values);
      return `<Select label="${name}" ${tid} data={${data}} allowDeselect={false} value={(form.values as Record<string, unknown>)["${name}"] as string | null ?? null} onChange={(v) => form.setFieldValue("${name}", (v ?? "") as never)} error={form.errors["${name}"]} />`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      const sub = vo.fields
        .map((vf) =>
          formInput(`${name}.${vf.name}`, vf.type, ctx, `${testId}-${vf.name}`),
        )
        .join("\n          ");
      return `<Fieldset legend="${name}" data-testid="${testId}">\n          ${sub}\n        </Fieldset>`;
    }
    return `<TextInput ${props} ${tid} />`;
  }
  if (inner.kind === "array") {
    return `<TextInput ${props} ${tid} placeholder="(arrays not yet supported in forms)" disabled />`;
  }
  return `<TextInput ${props} ${tid} />`;
}

/**
 * Render a TS object literal with sensible defaults for each field.
 * Uses `new Date()` for datetimes (which JSON form binders can't
 * express) and string-cast initial values for ids / enums.
 */
function initialValuesTs(
  fields: { name: string; type: TypeIR; optional: boolean }[],
  ctx: BoundedContextIR,
): string {
  const entries = fields.map(
    (f) => `${f.name}: ${initialValueTs(f.type, ctx, f.optional)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function initialValueTs(t: TypeIR, ctx: BoundedContextIR, optional: boolean): string {
  const inner = unwrapOpt(t);
  if (optional && inner.kind === "primitive") {
    return "null";
  }
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "bool":
        return "false";
      case "datetime":
        return `""`;
      default:
        return `""`;
    }
  }
  if (inner.kind === "id") return `""`;
  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    return en ? JSON.stringify(en.values[0]) : `""`;
  }
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (!vo) return "{}";
    const inner2 = vo.fields
      .map((vf) => `${vf.name}: ${initialValueTs(vf.type, ctx, false)}`)
      .join(", ");
    return `{ ${inner2} }`;
  }
  if (inner.kind === "array") return "[]";
  return `""`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

function isPrimitiveLike(t: TypeIR): boolean {
  const inner = unwrapOpt(t);
  return (
    inner.kind === "primitive" ||
    inner.kind === "id" ||
    inner.kind === "enum"
  );
}

function displayCellExpr(slug: string, f: FieldIR): string {
  const t = unwrapOpt(f.type);
  const tid = `\`${slug}-row-\${row.id}-${f.name}\``;
  if (t.kind === "enum") {
    return `<Table.Td data-testid={${tid}}><Badge tt="unset">{row.${f.name}}</Badge></Table.Td>`;
  }
  return `<Table.Td data-testid={${tid}}>{String(row.${f.name} ?? "")}</Table.Td>`;
}

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

// Suppress unused-import warnings.
void (null as unknown as ValueObjectIR);
