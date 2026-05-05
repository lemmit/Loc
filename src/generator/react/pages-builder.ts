import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  FieldIR,
  ParamIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";
import {
  componentsForFields,
  formInput,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  isPrimitiveLike,
  needsController,
  unwrapOpt,
  usesDateTimePicker,
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
    .map((t) => `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}.js";`)
    .join("\n");
  const idHookCalls = idTargets
    .map((t) => `  const ${idTargetHookVar(t)} = useAll${plural(t.name)}();`)
    .join("\n");
  const mantineImports = ["Stack", "Title", "Button", "Group"]
    .concat([...componentsForFields(fields, ctx)].sort())
    .join(", ");
  const useFormImports = needsController(fields, ctx)
    ? "useForm, Controller"
    : "useForm";
  const destructuredHookFields = needsController(fields, ctx)
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const dateImport = usesDateTimePicker(fields, ctx)
    ? `\nimport { DateTimePicker } from "@mantine/dates";`
    : "";
  return `// Auto-generated.
import { useNavigate } from "react-router-dom";
import { ${mantineImports} } from "@mantine/core";${dateImport}
import { notifications } from "@mantine/notifications";
import { ${useFormImports} } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Create${agg.name}Request, useCreate${agg.name} } from "../../api/${camel(agg.name)}.js";${idHookImports ? "\n" + idHookImports : ""}

export default function ${cap}New(): JSX.Element {
  const navigate = useNavigate();
  const create = useCreate${agg.name}();
${idHookCalls ? idHookCalls + "\n" : ""}  const ${destructuredHookFields} = useForm<Create${agg.name}Request>({
    resolver: zodResolver(Create${agg.name}Request),
    defaultValues: ${initialValuesTs(fields, ctx)},
  });
  return (
    <Stack maw={600} data-testid="${slug}-new">
      <Title order={2}>New ${agg.name.toLowerCase()}</Title>
      <form
        onSubmit={handleSubmit(async (vals) => {
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
    .map((op) => renderOperationButton(slug, op))
    .join("\n          ");

  // Detail-page components: card / table / badge / anchor for display
  // + the input set used by every operation modal.
  const displayComponents = ["Stack", "Title", "Card", "Group", "Button", "Text", "Loader", "Alert", "Anchor"];
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
  const detailDateImport = usesDateTimePicker(
    ops.flatMap((o) => o.params.map((p) => ({ type: p.type }))),
    ctx,
  )
    ? `\nimport { DateTimePicker } from "@mantine/dates";`
    : "";
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
    .map((t) => `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}.js";`)
    .join("\n");

  return `// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { ${mantineImports} } from "@mantine/core";${detailDateImport}
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { ${detailUseFormImports} } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { use${agg.name}ById${ops.length > 0 ? `, ${opHookImports}` : ""}${reqImports.length > 0 ? `, ${reqImports}` : ""} } from "../../api/${camel(agg.name)}.js";${detailIdHookImports ? "\n" + detailIdHookImports : ""}

export default function ${cap}Detail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
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
  return `function open${cap}Modal(mut: ReturnType<typeof use${cap}${agg.name}>): void {
  modals.open({
    title: "${op.name}",
    children: <${cap}Form mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function ${cap}Form({ mut, onClose }: { mut: ReturnType<typeof use${cap}${agg.name}>; onClose: () => void }): JSX.Element {
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
// Misc
// ---------------------------------------------------------------------------

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
