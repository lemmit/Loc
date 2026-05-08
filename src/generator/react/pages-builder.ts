import type {
  AggregateIR,
  BoundedContextIR,
  ParamIR,
} from "../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../util/naming.js";
import {
  componentsForFields,
  formInput,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "./form-helpers.js";

// ---------------------------------------------------------------------------
// Per-aggregate React pages — `new` form page only at this stage.
//
// Phase 0 / 1.1 / 1.2 / 1.3 of the template-pack rollout moved the
// list page, theme, project shell, and detail page out of this
// module; the remaining hand-written builder is `buildNewPage`.
// Phase 1.4 ports it (and the operation modal-form helper exported
// here) to template-driven emission.
//
// Stable `data-testid`s on every interactive element survive the
// port: Playwright page objects under e2e/pages/ key off them.
// ---------------------------------------------------------------------------

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
// (new page: no aggregate data fetched yet, no display-field title.)
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

// ---------------------------------------------------------------------------
// Operation modal-form emission — produces the `function openXModal`
// + `function XForm` pair appended to a detail page's TSX module.
// Called from preparers/detail.ts (the page itself is template-
// rendered) and slated for Phase 1.4 template port.
// ---------------------------------------------------------------------------

export function renderOperationModalFn(
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
// Misc utilities — small helpers shared with the templating preparers.
// ---------------------------------------------------------------------------

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Pick a tabler-icon component name for an operation based on its
 *  verb prefix.  Returns `undefined` when nothing matches so the
 *  button stays plain rather than getting a misleading icon. */
export function iconForOp(opName: string): string | undefined {
  const lower = opName.toLowerCase();
  if (/^(add|append|create|insert|new)/.test(lower)) return "IconPlus";
  if (/^(remove|delete|drop|clear)/.test(lower)) return "IconTrash";
  if (/^(confirm|approve|complete|finish|finalize|finalise|publish)/.test(lower)) return "IconCheck";
  if (/^(cancel|abort|reject|deny)/.test(lower)) return "IconX";
  if (/^(ship|deliver|dispatch|send)/.test(lower)) return "IconTruckDelivery";
  if (/^(pay|charge|refund)/.test(lower)) return "IconCreditCard";
  if (/^(start|begin|open)/.test(lower)) return "IconPlayerPlay";
  if (/^(stop|close|end)/.test(lower)) return "IconPlayerStop";
  if (/^(update|edit|change|modify|rename|set)/.test(lower)) return "IconPencil";
  if (/^(assign|attach|link)/.test(lower)) return "IconLink";
  return undefined;
}

/** When a `string` field is conventionally named `<Aggregate>Id`
 *  (e.g. `customerId: string` referencing aggregate `Customer`),
 *  treat it as a soft foreign key so the cell can link to the
 *  target's detail page without requiring the source DSL to upgrade
 *  to an explicit `Id<Customer>`.  Returns the aggregate match when
 *  one applies, otherwise undefined. */
export function stringIdHeuristic(
  fieldName: string,
  t: { kind: string; name?: string },
  aggregatesByName: Map<string, AggregateIR>,
): { targetName: string } | undefined {
  if (t.kind !== "primitive" || t.name !== "string") return undefined;
  const m = /^([a-z][A-Za-z0-9]*)Id$/.exec(fieldName);
  if (!m) return undefined;
  const candidate = m[1]![0]!.toUpperCase() + m[1]!.slice(1);
  if (aggregatesByName.has(candidate)) return { targetName: candidate };
  return undefined;
}
