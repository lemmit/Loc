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
    `<Table.Td><Anchor component={Link} to={\`/${slug}/\${row.id}\`}>{row.id.slice(0, 8)}…</Anchor></Table.Td>`,
  );
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) cells.push(displayCellExpr(f));
  }
  return `// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge } from "@mantine/core";
import { useAll${plural(agg.name)} } from "../../api/${camel(agg.name)}.js";

export default function ${cap}List(): JSX.Element {
  const navigate = useNavigate();
  const q = useAll${plural(agg.name)}();
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>${plural(agg.name)}</Title>
        <Button onClick={() => navigate("/${slug}/new")}>Create ${agg.name.toLowerCase()}</Button>
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
              <Table.Tr key={row.id}>
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
  const formFields = fields.map((f) => formInput(f.name, f.type, ctx)).join("\n        ");
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
    <Stack maw={600}>
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
            <Button type="submit" loading={create.isPending}>Create</Button>
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

  // Imports for hooks.
  const opHookImports = ops
    .map((op) => `use${upper(op.name)}${agg.name}`)
    .join(", ");
  const reqImports = ops
    .map((op) => `${upper(op.name)}Request`)
    .join(", ");

  const fieldDisplay = agg.fields
    .map((f) => fieldDisplayLine(f, ctx))
    .join("\n        ");

  const partsBlocks = agg.contains
    .map((c) => {
      const part = agg.parts.find((p) => p.name === c.partName);
      return part ? renderPartTable(part, c.name, c.collection) : "";
    })
    .filter(Boolean)
    .join("\n        ");

  const opButtons = ops
    .map((op) => renderOperationButton(agg, op))
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
    <Stack>
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

${ops.map((op) => renderOperationModalFn(agg, op, ctx)).join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// Detail-page helpers
// ---------------------------------------------------------------------------

function fieldDisplayLine(f: FieldIR, ctx: BoundedContextIR): string {
  const t = unwrapOpt(f.type);
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      const inner = vo.fields
        .map((vf) => `${vf.name}: {String(data.${f.name}.${vf.name})}`)
        .join(", ");
      return `<Text><strong>${f.name}:</strong> ${inner}</Text>`;
    }
  }
  if (t.kind === "enum") {
    return `<Text><strong>${f.name}:</strong> <Badge>{data.${f.name}}</Badge></Text>`;
  }
  return `<Text><strong>${f.name}:</strong> {String(data.${f.name})}</Text>`;
}

function renderPartTable(
  part: EntityPartIR,
  name: string,
  collection: boolean,
): string {
  if (!collection) {
    return `<Card withBorder><Title order={4}>${name}</Title><Text>{JSON.stringify(data.${name})}</Text></Card>`;
  }
  const cols = ["id", ...part.fields.filter((f) => isPrimitiveLike(f.type)).map((f) => f.name)];
  return `<Card withBorder>
        <Title order={4}>${name}</Title>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              ${cols.map((c) => `<Table.Th>${c}</Table.Th>`).join("\n              ")}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.${name}.map((row) => (
              <Table.Tr key={row.id}>
                ${cols.map((c) => `<Table.Td>{String(row.${c} ?? "")}</Table.Td>`).join("\n                ")}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>`;
}

function renderOperationButton(
  agg: AggregateIR,
  op: { name: string; params: ParamIR[] },
): string {
  return `<Button onClick={() => open${upper(op.name)}Modal(${camel(op.name)})}>${op.name}</Button>`;
}

function renderOperationModalFn(
  agg: AggregateIR,
  op: { name: string; params: ParamIR[] },
  ctx: BoundedContextIR,
): string {
  const cap = upper(op.name);
  const formFields = op.params.length > 0
    ? op.params.map((p) => formInput(p.name, p.type, ctx)).join("\n        ")
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
          <Button type="submit" loading={mut.isPending}>${op.name}</Button>
        </Group>
      </Stack>
    </form>
  );
}`;
}

// ---------------------------------------------------------------------------
// Form-input helpers
// ---------------------------------------------------------------------------

function formInput(name: string, t: TypeIR, ctx: BoundedContextIR): string {
  const inner = unwrapOpt(t);
  const props = `label="${name}" {...form.getInputProps("${name}")}`;
  if (inner.kind === "primitive") {
    if (inner.name === "int" || inner.name === "long") {
      return `<NumberInput ${props} allowDecimal={false} />`;
    }
    if (inner.name === "decimal") {
      return `<NumberInput ${props} decimalScale={2} fixedDecimalScale />`;
    }
    if (inner.name === "bool") {
      return `<Switch label="${name}" checked={!!form.values.${name}} onChange={(e) => form.setFieldValue("${name}", e.currentTarget.checked)} />`;
    }
    if (inner.name === "datetime") {
      return `<DateTimePicker ${props} />`;
    }
    return `<TextInput ${props} />`;
  }
  if (inner.kind === "id") {
    return `<TextInput ${props} placeholder="<id>" />`;
  }
  if (inner.kind === "enum") {
    const en = ctx.enums.find((e) => e.name === inner.name);
    if (en) {
      const data = JSON.stringify(en.values);
      return `<Select ${props} data={${data}} />`;
    }
    return `<TextInput ${props} />`;
  }
  if (inner.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === inner.name);
    if (vo) {
      const sub = vo.fields
        .map((vf) => formInput(`${name}.${vf.name}`, vf.type, ctx))
        .join("\n          ");
      return `<Fieldset legend="${name}">\n          ${sub}\n        </Fieldset>`;
    }
    return `<TextInput ${props} />`;
  }
  if (inner.kind === "array") {
    return `<TextInput ${props} placeholder="(arrays not yet supported in forms)" disabled />`;
  }
  return `<TextInput ${props} />`;
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
  if (optional && (inner.kind === "primitive" && inner.name !== "datetime")) {
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
        return "new Date()";
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

function displayCellExpr(f: FieldIR): string {
  const t = unwrapOpt(f.type);
  if (t.kind === "enum") {
    return `<Table.Td><Badge>{row.${f.name}}</Badge></Table.Td>`;
  }
  return `<Table.Td>{String(row.${f.name} ?? "")}</Table.Td>`;
}

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

// Suppress unused-import warnings.
void (null as unknown as ValueObjectIR);
