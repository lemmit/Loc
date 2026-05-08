import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  FieldIR,
  ParamIR,
} from "../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../util/naming.js";
import {
  componentsForFields,
  formInput,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  isPrimitiveLike,
  needsController,
  unwrapOpt,
} from "./form-helpers.js";

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
  const humanPlural = humanize(plural(agg.name));
  const humanSingular = humanize(agg.name);
  const cols: string[] = [];
  cols.push(`<Table.Th>Id</Table.Th>`);
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type))
      cols.push(`<Table.Th>${humanize(f.name)}</Table.Th>`);
  }
  const cells: string[] = [];
  cells.push(
    `<Table.Td><Anchor component={Link} to={\`/${slug}/\${row.id}\`} data-testid={\`${slug}-row-\${row.id}-link\`}><IdValue id={row.id} /></Anchor></Table.Td>`,
  );
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) cells.push(displayCellExpr(slug, f));
  }
  return `// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge, Center, Text, Paper } from "@mantine/core";
import { useAll${plural(agg.name)} } from "../../api/${camel(agg.name)}";
import { IdValue, DateTimeValue, BoolValue, EmptyValue } from "../../lib/format";

export default function ${cap}List() {
  const navigate = useNavigate();
  const q = useAll${plural(agg.name)}();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="${slug}-list" gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>${humanPlural}</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 record" : count + " records"}</Text>
        </Stack>
        <Button onClick={() => navigate("/${slug}/new")} data-testid="${slug}-list-create">+ New ${humanSingular.toLowerCase()}</Button>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red" variant="light" title="Couldn't load ${humanPlural.toLowerCase()}">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Paper p="xl" data-testid="${slug}-list-empty">
          <Center mih={160}>
            <Stack gap="xs" align="center">
              <Text c="dimmed">No ${humanPlural.toLowerCase()} yet.</Text>
              <Button variant="light" onClick={() => navigate("/${slug}/new")}>
                Create your first ${humanSingular.toLowerCase()}
              </Button>
            </Stack>
          </Center>
        </Paper>
      )}
      {q.data && q.data.length > 0 && (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  ${cols.join("\n                  ")}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row) => (
                  <Table.Tr key={row.id} data-testid={\`${slug}-row-\${row.id}\`} style={{ cursor: "pointer" }} onClick={() => navigate(\`/${slug}/\${row.id}\`)}>
                    ${cells.join("\n                    ")}
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

export function buildNewPage(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): string {
  const slug = snake(plural(agg.name));
  const cap = upper(agg.name);
  const fields = agg.fields.filter((f) => !f.optional);
  const formFields = fields
    .map((f) =>
      formInput(f.name, f.type, ctx, `${slug}-new-input-${f.name}`, aggregatesByName),
    )
    .join("\n        ");
  // Phase 3: aggregates referenced by `Id<X>` fields need a
  // `useAll<X>()` query at the top of the form component.
  const idTargets = idTargetsInFields(fields, ctx, aggregatesByName);
  const idHookImports = idTargets
    .map((t) => `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}";`)
    .join("\n");
  const idHookCalls = idTargets
    .map((t) => `  const ${idTargetHookVar(t)} = useAll${plural(t.name)}();`)
    .join("\n");
  const mantineImports = ["Stack", "Title", "Button", "Group", "Card", "Text", "Anchor", "Breadcrumbs"]
    .concat([...componentsForFields(fields, ctx)].sort())
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");
  const useFormImports = needsController(fields, ctx)
    ? "useForm, Controller"
    : "useForm";
  const destructuredHookFields = needsController(fields, ctx)
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const humanAgg = humanize(agg.name);
  const humanPlural = humanize(plural(agg.name));
  return `// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { ${mantineImports} } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ${useFormImports} } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Create${agg.name}Request, useCreate${agg.name} } from "../../api/${camel(agg.name)}";${idHookImports ? "\n" + idHookImports : ""}

export default function ${cap}New() {
  const navigate = useNavigate();
  const create = useCreate${agg.name}();
${idHookCalls ? idHookCalls + "\n" : ""}  const ${destructuredHookFields} = useForm<Create${agg.name}Request>({
    resolver: zodResolver(Create${agg.name}Request),
    defaultValues: ${initialValuesTs(fields, ctx)},
  });
  return (
    <Stack maw={640} data-testid="${slug}-new" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/${slug}">${humanPlural}</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>New ${humanAgg.toLowerCase()}</Text>
        <Title order={2}>Create ${humanAgg.toLowerCase()}</Title>
      </Stack>
      <Card>
        <form
          onSubmit={handleSubmit(async (vals) => {
            try {
              const out = await create.mutateAsync(vals);
              notifications.show({ color: "green", message: "${humanAgg} created" });
              navigate(\`/${slug}/\${out.id}\`);
            } catch (e) {
              notifications.show({ color: "red", message: (e as Error).message });
            }
          })}
        >
          <Stack gap="md">
          ${formFields}
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => navigate("/${slug}")}>Cancel</Button>
              <Button type="submit" loading={create.isPending} data-testid="${slug}-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
`;
}

export function buildDetailPage(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): string {
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
    .map((op, i) => renderOperationButton(slug, op, i))
    .join("\n          ");

  // Detail-page components: card / table / breadcrumbs / badge for
  // display + the input set used by every operation modal.
  const displayComponents = [
    "Stack",
    "Title",
    "Card",
    "Group",
    "Button",
    "Text",
    "Loader",
    "Alert",
    "Anchor",
    "Breadcrumbs",
    "Divider",
    "Code",
  ];
  if (agg.fields.some((f) => unwrapOpt(f.type).kind === "enum")) displayComponents.push("Badge");
  if (agg.contains.length > 0) displayComponents.push("Table", "Badge");
  // Operation forms reuse the formInput vocabulary.
  const opFormComponents = componentsForFields(
    ops.flatMap((o) => o.params.map((p) => ({ type: p.type }))),
    ctx,
  );
  const mantineImports = [...new Set([...displayComponents, ...opFormComponents])].sort().join(", ");

  const detailUseFormImports =
    ops.length > 0 &&
    needsController(
      ops.flatMap((o) => o.params.map((p) => ({ type: p.type }))),
      ctx,
    )
      ? "useForm, Controller"
      : "useForm";
  // Phase 3: aggregates referenced by `Id<X>` op params need a
  // `useAll<X>()` query in their respective op modal forms.  Here at
  // the detail level we just emit the import — the hook calls
  // themselves go inside each modal's form component (different
  // components, different RHF instances).
  const detailIdTargets = idTargetsInFields(
    ops.flatMap((o) => o.params.map((p) => ({ type: p.type }))),
    ctx,
    aggregatesByName,
  );
  const detailIdHookImports = detailIdTargets
    .map((t) => `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}";`)
    .join("\n");

  const humanAgg = humanize(agg.name);
  const humanPlural = humanize(plural(agg.name));
  return `// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { ${mantineImports} } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { ${detailUseFormImports} } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { use${agg.name}ById${ops.length > 0 ? `, ${opHookImports}` : ""}${reqImports.length > 0 ? `, ${reqImports}` : ""} } from "../../api/${camel(agg.name)}";${detailIdHookImports ? "\n" + detailIdHookImports : ""}
import { IdValue, DateTimeValue, BoolValue, EmptyValue, KeyValueRow } from "../../lib/format";

export default function ${cap}Detail() {
  const { id } = useParams<{ id: string }>();
  const q = use${agg.name}ById(id);
${ops.map((op) => `  const ${camel(op.name)} = use${upper(op.name)}${agg.name}(id ?? "");`).join("\n")}
  if (q.isLoading) return <Loader />;
  if (q.isError) return <Alert color="red" variant="light" title="Couldn't load ${humanAgg.toLowerCase()}">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Alert color="yellow" variant="light" title="Not found">No ${humanAgg.toLowerCase()} matches that id.</Alert>;
  const data = q.data;
  return (
    <Stack data-testid="${slug}-detail" gap="md">
      <Breadcrumbs data-testid="${slug}-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/${slug}">${humanPlural}</Anchor>
        <Text>{data.id.slice(0, 8)}…</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>${humanAgg}</Text>
          <Group gap="sm" align="center">
            <Title order={2}>{data.id.slice(0, 8)}…</Title>
            <Code>{data.id}</Code>
          </Group>
        </Stack>
        ${ops.length > 0 ? `<Group gap="xs" data-testid="${slug}-detail-ops">
          ${opButtons}
        </Group>` : ""}
      </Group>
      <Card>
        <Stack gap="md">
        ${fieldDisplay}
        </Stack>
      </Card>
      ${partsBlocks}
    </Stack>
  );
}

${ops.map((op) => renderOperationModalFn(slug, agg, op, ctx, aggregatesByName)).join("\n\n")}
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
  const label = humanize(f.name);
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      const inner = vo.fields
        .map(
          (vf) =>
            `<Text size="sm"><Text component="span" c="dimmed">${humanize(vf.name)}: </Text><span data-testid="${tid}-${vf.name}">{String(data.${f.name}.${vf.name})}</span></Text>`,
        )
        .join("\n          ");
      return `<KeyValueRow label="${label}">
          ${inner}
        </KeyValueRow>`;
    }
  }
  if (t.kind === "enum") {
    // tt="unset" disables Mantine's default uppercasing so the rendered
    // text matches the enum value verbatim — predictable for tests.
    // component="span" keeps Badge inline so it nests legally inside
    // typography flow.
    return `<KeyValueRow label="${label}"><Badge tt="unset" component="span" variant="light" data-testid="${tid}">{data.${f.name}}</Badge></KeyValueRow>`;
  }
  if (t.kind === "id") {
    return `<KeyValueRow label="${label}"><span data-testid="${tid}"><IdValue id={data.${f.name}} /></span></KeyValueRow>`;
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return `<KeyValueRow label="${label}"><span data-testid="${tid}"><DateTimeValue iso={data.${f.name}} /></span></KeyValueRow>`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return `<KeyValueRow label="${label}"><span data-testid="${tid}"><BoolValue value={data.${f.name}} /></span></KeyValueRow>`;
  }
  return `<KeyValueRow label="${label}"><span data-testid="${tid}">{data.${f.name} === null || data.${f.name} === undefined || data.${f.name} === "" ? <EmptyValue /> : String(data.${f.name})}</span></KeyValueRow>`;
}

function renderPartTable(
  slug: string,
  part: EntityPartIR,
  name: string,
  collection: boolean,
): string {
  const sectionTitle = humanize(name);
  if (!collection) {
    return `<Card><Title order={4}>${sectionTitle}</Title><Text size="sm" c="dimmed" mt="xs">{JSON.stringify(data.${name})}</Text></Card>`;
  }
  const partFields = part.fields.filter((f) => isPrimitiveLike(f.type));
  const cols = ["id", ...partFields.map((f) => f.name)];
  const colHeaders = cols
    .map((c) => `<Table.Th>${humanize(c)}</Table.Th>`)
    .join("\n                ");
  const cellExprs = (c: string): string => {
    if (c === "id") {
      return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}><IdValue id={row.${c}} /></Table.Td>`;
    }
    const fld = partFields.find((f) => f.name === c);
    if (fld) {
      const t = unwrapOpt(fld.type);
      if (t.kind === "id") {
        return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}><IdValue id={row.${c}} /></Table.Td>`;
      }
      if (t.kind === "primitive" && t.name === "datetime") {
        return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}><DateTimeValue iso={row.${c}} /></Table.Td>`;
      }
      if (t.kind === "primitive" && t.name === "bool") {
        return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}><BoolValue value={row.${c}} /></Table.Td>`;
      }
      if (t.kind === "enum") {
        return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}><Badge tt="unset" variant="light">{row.${c}}</Badge></Table.Td>`;
      }
    }
    return `<Table.Td data-testid={\`${slug}-detail-${name}-row-\${row.id}-${c}\`}>{row.${c} === null || row.${c} === undefined || row.${c} === "" ? <EmptyValue /> : String(row.${c})}</Table.Td>`;
  };
  const partSlug = snake(plural(part.name));
  return `<Card>
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Title order={4}>${sectionTitle}</Title>
            <Text size="sm" c="dimmed">{data.${name}.length === 1 ? "1 item" : data.${name}.length + " items"}</Text>
          </Group>
          <Table.ScrollContainer minWidth={400}>
            <Table striped highlightOnHover data-testid="${slug}-detail-${name}">
              <Table.Thead>
                <Table.Tr>
                  ${colHeaders}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.${name}.map((row) => (
                  <Table.Tr key={row.id} data-testid={\`${slug}-detail-${name}-row-\${row.id}\`}>
                    ${cols.map(cellExprs).join("\n                    ")}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
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
  index: number,
): string {
  // First op gets the filled (primary) variant so the most-likely
  // "next step" pops; subsequent ops use light variant so the
  // header doesn't turn into a wall of solid buttons.
  const variant = index === 0 ? "filled" : "light";
  return `<Button variant="${variant}" onClick={() => open${upper(op.name)}Modal(${camel(op.name)})} data-testid="${slug}-op-${op.name}">${humanize(op.name)}</Button>`;
}

function renderOperationModalFn(
  slug: string,
  agg: AggregateIR,
  op: { name: string; params: ParamIR[] },
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): string {
  const cap = upper(op.name);
  const opFields = op.params.map((p) => ({ type: p.type }));
  const useController = needsController(opFields, ctx);
  const destructured = useController
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const formFields =
    op.params.length > 0
      ? op.params
          .map((p) =>
            formInput(
              p.name,
              p.type,
              ctx,
              `${slug}-op-${op.name}-input-${p.name}`,
              aggregatesByName,
            ),
          )
          .join("\n        ")
      : `<Text>This operation has no parameters.</Text>`;
  // Phase 3: every `Id<X>` param drives a `useAll<X>()` hook call at
  // the form-component scope.  formInput emits the JSX referencing
  // these variables.
  const opIdTargets = idTargetsInFields(opFields, ctx, aggregatesByName);
  const opIdHookCalls = opIdTargets
    .map((t) => `  const ${idTargetHookVar(t)} = useAll${plural(t.name)}();`)
    .join("\n");
  const humanOp = humanize(op.name);
  return `function open${cap}Modal(mut: ReturnType<typeof use${cap}${agg.name}>): void {
  modals.open({
    title: "${humanOp}",
    children: <${cap}Form mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function ${cap}Form({ mut, onClose }: { mut: ReturnType<typeof use${cap}${agg.name}>; onClose: () => void }) {
${opIdHookCalls ? opIdHookCalls + "\n" : ""}  const ${destructured} = useForm<${cap}Request>({
    resolver: zodResolver(${cap}Request),
    defaultValues: ${initialValuesTs(op.params.map((p) => ({ name: p.name, type: p.type, optional: false })), ctx)},
  });
  return (
    <form
      data-testid="${slug}-op-${op.name}-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "${humanOp} succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        ${formFields}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="${slug}-op-${op.name}-submit">${humanOp}</Button>
        </Group>
      </Stack>
    </form>
  );
}`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function displayCellExpr(slug: string, f: FieldIR): string {
  const t = unwrapOpt(f.type);
  const tid = `\`${slug}-row-\${row.id}-${f.name}\``;
  if (t.kind === "enum") {
    return `<Table.Td data-testid={${tid}}><Badge tt="unset" variant="light">{row.${f.name}}</Badge></Table.Td>`;
  }
  if (t.kind === "id") {
    return `<Table.Td data-testid={${tid}}><IdValue id={row.${f.name}} /></Table.Td>`;
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return `<Table.Td data-testid={${tid}}><DateTimeValue iso={row.${f.name}} /></Table.Td>`;
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return `<Table.Td data-testid={${tid}}><BoolValue value={row.${f.name}} /></Table.Td>`;
  }
  return `<Table.Td data-testid={${tid}}>{row.${f.name} === null || row.${f.name} === undefined || row.${f.name} === "" ? <EmptyValue /> : String(row.${f.name})}</Table.Td>`;
}

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
