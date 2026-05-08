import type {
  AggregateIR,
  BoundedContextIR,
  WorkflowIR,
} from "../../ir/loom-ir.js";
import { camel, humanize as humanizeUtil, plural, snake } from "../../util/naming.js";
import {
  componentsForFields,
  formInput,
  idTargetHookVar,
  idTargetsInFields,
  initialValuesTs,
  needsController,
} from "./form-helpers.js";
import { fillBlock } from "./page-objects-builder.js";

// ---------------------------------------------------------------------------
// Workflow UI emission for the React generator.
//
// Workflows are surfaced by the backend as `POST /workflows/<slug>`
// endpoints with a body matching the workflow's parameter list (see
// `src/generator/typescript/workflow-builder.ts`).  This module turns
// every workflow into a generated React page so a user can invoke it
// without dropping to curl / Postman:
//
//   /workflows                index page — one card per workflow
//   /workflows/<slug>          per-workflow form — submit → toast →
//                              navigate back
//
// Form rendering reuses the v4 form-helpers (`formInput`,
// `componentsForFields`, etc.) so workflow params get the same typed
// inputs operations already get: Id<X> Select with target's display
// field, datetime via native input, NumberInput / Switch / TextInput
// for primitives, enum Select.
//
// The mutation hook (`use<Workflow>Workflow`) lives in
// `src/api/workflows.ts`, alongside per-workflow request schemas.
// Errors come back from the backend in the `{ error, trace_id }`
// envelope from slice 16.C; the form-level catch shows the error
// message via Mantine notifications and (when present) appends the
// trace id so operators can correlate to log lines.
// ---------------------------------------------------------------------------

/** Whether any workflow exists across the deployable's contexts. */
export function hasAnyWorkflow(contexts: BoundedContextIR[]): boolean {
  return contexts.some((c) => c.workflows.length > 0);
}

/** Gather every workflow with its owning context, sorted by name for
 *  stable emission (the index page + sidebar entries iterate this). */
export function allWorkflows(
  contexts: BoundedContextIR[],
): Array<{ wf: WorkflowIR; ctx: BoundedContextIR }> {
  const out: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const wf of ctx.workflows) out.push({ wf, ctx });
  }
  out.sort((a, b) => a.wf.name.localeCompare(b.wf.name));
  return out;
}

// ---------------------------------------------------------------------------
// API module — Zod schemas + mutation hooks for every workflow in the
// deployable.  One file at `src/api/workflows.ts` aggregating them all
// (workflows are flat at the system level; no per-context split needed).
// ---------------------------------------------------------------------------

export function buildWorkflowsApiModule(
  contexts: BoundedContextIR[],
): string {
  const workflows = allWorkflows(contexts);
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { z } from "zod";`);
  lines.push(`import { useMutation } from "@tanstack/react-query";`);
  lines.push(`import { api } from "./client";`);
  // Per-workflow Zod schemas may reference enum / VO schemas declared
  // in per-aggregate api modules.  Workflows are cross-context, so we
  // can't pre-import every schema; we lean on `zodFor` to inline
  // primitives + ids + datetime, and the per-workflow file imports
  // any needed enum/VO schema from its source aggregate's api module.
  const enumDeps = collectEnumDeps(workflows);
  const voDeps = collectValueObjectDeps(workflows);
  for (const dep of [...enumDeps, ...voDeps]) {
    lines.push(
      `import { ${dep.schemaName} } from "./${camel(dep.fromAggregate)}";`,
    );
  }
  lines.push("");

  for (const { wf } of workflows) {
    lines.push(`export const ${cap(wf.name)}Request = z.object({`);
    for (const p of wf.params) {
      lines.push(`  ${p.name}: ${zodForRequest(p.type)},`);
    }
    lines.push(`});`);
    lines.push(
      `export type ${cap(wf.name)}Request = z.infer<typeof ${cap(wf.name)}Request>;`,
    );
    lines.push("");
    // Mutation — POST /workflows/<slug>, 204 No Content on success.
    lines.push(`export function use${cap(wf.name)}Workflow() {`);
    lines.push(`  return useMutation({`);
    lines.push(`    mutationFn: async (input: ${cap(wf.name)}Request) => {`);
    lines.push(
      `      await api.post(\`/workflows/${snake(wf.name)}\`, input);`,
    );
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
  workflows: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }>,
): EnumDep[] {
  const out = new Map<string, EnumDep>();
  for (const { wf, ctx } of workflows) {
    for (const p of wf.params) {
      walkType(p.type, (t) => {
        if (t.kind === "enum") {
          const owner = findFirstAggregateUsingEnum(ctx, t.name);
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

function collectValueObjectDeps(
  workflows: Array<{ wf: WorkflowIR; ctx: BoundedContextIR }>,
): VoDep[] {
  const out = new Map<string, VoDep>();
  for (const { wf, ctx } of workflows) {
    for (const p of wf.params) {
      walkType(p.type, (t) => {
        if (t.kind === "valueobject") {
          const owner = findFirstAggregateUsingValueObject(ctx, t.name);
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

function findFirstAggregateUsingEnum(
  ctx: BoundedContextIR,
  enumName: string,
): string | undefined {
  for (const a of ctx.aggregates) {
    let used = false;
    const visit = (t: import("../../ir/loom-ir.js").TypeIR): void => {
      if (used) return;
      if (t.kind === "enum" && t.name === enumName) used = true;
      else if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (used) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

function findFirstAggregateUsingValueObject(
  ctx: BoundedContextIR,
  voName: string,
): string | undefined {
  for (const a of ctx.aggregates) {
    let used = false;
    const visit = (t: import("../../ir/loom-ir.js").TypeIR): void => {
      if (used) return;
      if (t.kind === "valueobject" && t.name === voName) used = true;
      else if (t.kind === "array") visit(t.element);
      else if (t.kind === "optional") visit(t.inner);
    };
    for (const f of a.fields) visit(f.type);
    if (used) return a.name;
  }
  return ctx.aggregates[0]?.name;
}

function walkType(
  t: import("../../ir/loom-ir.js").TypeIR,
  visit: (t: import("../../ir/loom-ir.js").TypeIR) => void,
): void {
  visit(t);
  if (t.kind === "array") walkType(t.element, visit);
  else if (t.kind === "optional") walkType(t.inner, visit);
}

// ---------------------------------------------------------------------------
// Index page — `pages/workflows/index.tsx`.  Lists every workflow as a
// card with name + parameter signature + a "Run" button.
// ---------------------------------------------------------------------------

export function buildWorkflowsIndexPage(contexts: BoundedContextIR[]): string {
  const workflows = allWorkflows(contexts);
  const cards = workflows
    .map(({ wf }) => {
      const slug = snake(wf.name);
      const human = humanise(wf.name);
      const params = wf.params
        .map(
          (p) =>
            // typeLabel may contain '<' / '>' (e.g. `Id<Product>`);
            // emit as a JS string literal so React renders it as
            // text rather than parsing it as a JSX element.
            `          <Text size="sm" c="dimmed" data-testid="workflow-${slug}-param-${p.name}"><strong>${humanizeUtil(p.name)}</strong>: {${JSON.stringify(typeLabel(p.type))}}</Text>`,
        )
        .join("\n");
      const paramsBlock =
        wf.params.length > 0
          ? params
          : `          <Text size="sm" c="dimmed">No parameters.</Text>`;
      return `      <Card data-testid="workflow-card-${slug}">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Title order={4}>${human}</Title>
            <Button component={Link} to="/workflows/${slug}" data-testid="workflow-${slug}-run">Run →</Button>
          </Group>
${paramsBlock}
        </Stack>
      </Card>`;
    })
    .join("\n");
  return `// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Text, Card, Group, Button, SimpleGrid } from "@mantine/core";

export default function WorkflowsIndex() {
  return (
    <Stack data-testid="workflows-index" gap="md">
      <Stack gap={2}>
        <Title order={2}>Workflows</Title>
        <Text c="dimmed">System-level orchestrations.  Pick one to run.</Text>
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
// Per-workflow form page — `pages/workflows/<slug>.tsx`.  Form inputs
// come from `formInput` (same machinery as aggregate ops); submit posts
// the wire-shaped body and shows a green/red Mantine notification with
// the trace_id from the slice 16.C envelope when present.
// ---------------------------------------------------------------------------

export function buildWorkflowFormPage(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): string {
  const slug = snake(wf.name);
  const human = humanise(wf.name);
  const fields = wf.params.map((p) => ({
    name: p.name,
    type: p.type,
    optional: false,
  }));
  // Reuse the same form-helpers operation modals use.  Same field
  // testid prefix shape (`workflow-<slug>-input-<name>`) so the
  // Playwright page object emitted in slice 18.C can reuse fillBlock.
  const formFields =
    wf.params.length > 0
      ? wf.params
          .map((p) =>
            formInput(
              p.name,
              p.type,
              ctx,
              `workflow-${slug}-input-${p.name}`,
              aggregatesByName,
            ),
          )
          .join("\n        ")
      : `<Text>This workflow has no parameters.</Text>`;
  const idTargets = idTargetsInFields(fields, ctx, aggregatesByName);
  const idHookImports = idTargets
    .map(
      (t) =>
        `import { useAll${pluralCap(t.name)} } from "../../api/${camel(t.name)}";`,
    )
    .join("\n");
  const idHookCalls = idTargets
    .map((t) => `  const ${idTargetHookVar(t)} = useAll${pluralCap(t.name)}();`)
    .join("\n");
  const useController = needsController(fields, ctx);
  const destructured = useController
    ? "{ register, handleSubmit, control, formState: { errors } }"
    : "{ register, handleSubmit, formState: { errors } }";
  const useFormImports = useController ? "useForm, Controller" : "useForm";
  const mantineImports = [
    "Stack",
    "Title",
    "Button",
    "Group",
    "Anchor",
    "Text",
    "Card",
    "Breadcrumbs",
    ...componentsForFields(fields, ctx),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(", ");
  const componentName = `${cap(wf.name)}WorkflowPage`;
  return `// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { ${mantineImports} } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ${useFormImports} } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ${cap(wf.name)}Request, use${cap(wf.name)}Workflow } from "../../api/workflows";${
    idHookImports ? "\n" + idHookImports : ""
  }

export default function ${componentName}() {
  const navigate = useNavigate();
  const run = use${cap(wf.name)}Workflow();
${idHookCalls ? idHookCalls + "\n" : ""}  const ${destructured} = useForm<${cap(wf.name)}Request>({
    resolver: zodResolver(${cap(wf.name)}Request),
    defaultValues: ${initialValuesTs(fields, ctx)},
  });
  return (
    <Stack maw={640} data-testid="workflow-${slug}" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/workflows">Workflows</Anchor>
        <Text>${human}</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Workflow</Text>
        <Title order={2}>${human}</Title>
      </Stack>
      <Card>
        <form
          onSubmit={handleSubmit(async (vals) => {
            try {
              await run.mutateAsync(vals);
              notifications.show({ color: "green", message: "${human} completed" });
              navigate("/workflows");
            } catch (e) {
              notifications.show({ color: "red", message: (e as Error).message });
            }
          })}
        >
          <Stack gap="md">
          ${formFields}
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => navigate("/workflows")}>Cancel</Button>
              <Button type="submit" loading={run.isPending} data-testid="workflow-${slug}-submit">Run</Button>
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
// Playwright page object — slice 18.C.  Emitted into
// `e2e/pages/workflows/<slug>.ts`.  One class per workflow:
//
//   class <Cap>WorkflowPage {
//     async goto(): Promise<this>          // navigate, wait for form
//     async fill(input): Promise<this>     // typed input from <Wf>Request
//     async submit(): Promise<void>        // click submit, wait toast
//     async run(input): Promise<void>      // goto + fill + submit
//   }
//
// Drives the DOM via the testid prefix used by the form page
// (`workflow-<slug>-input-<param>` etc.).  Reuses the existing
// fillBlock helper from page-objects-builder so each parameter type
// (Id<X> select, datetime, primitives, enum, value-object) follows
// the same Playwright interaction convention as the aggregate
// operation modals.
// ---------------------------------------------------------------------------

export function buildWorkflowPageObject(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
): string {
  const slug = snake(wf.name);
  const className = `${cap(wf.name)}WorkflowPage`;
  const requestType = `${cap(wf.name)}Request`;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import type { Page } from "@playwright/test";`);
  lines.push(
    `import type { ${requestType} } from "../../../src/api/workflows";`,
  );
  lines.push("");
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly url = "/workflows/${slug}";`);
  lines.push(`  constructor(public readonly page: Page) {}`);
  lines.push("");
  lines.push(`  async goto(): Promise<this> {`);
  lines.push(`    await this.page.goto(${className}.url);`);
  lines.push(`    await this.page.getByTestId("workflow-${slug}").waitFor();`);
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async fill(input: Partial<${requestType}>): Promise<this> {`);
  for (const p of wf.params) {
    const fillLines = fillBlock(
      "input",
      p.name,
      p.type,
      ctx,
      `workflow-${slug}-input-${p.name}`,
    );
    for (const l of fillLines) lines.push(`    ${l}`);
  }
  lines.push(`    return this;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async submit(): Promise<void> {`);
  lines.push(
    `    await this.page.getByTestId("workflow-${slug}-submit").click();`,
  );
  // Wait for navigation back to /workflows (the form's onSuccess
  // navigates) instead of relying on a transient toast.  More
  // reliable across Playwright/animation timing.
  lines.push(`    await this.page.waitForURL(/\\/workflows$/);`);
  lines.push(`  }`);
  lines.push("");
  lines.push(
    `  async run(input: ${requestType}): Promise<void> {`,
  );
  lines.push(`    await this.goto();`);
  lines.push(`    await this.fill(input);`);
  lines.push(`    await this.submit();`);
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function pluralCap(name: string): string {
  // The naming helper produces a lowercase plural; capitalise for
  // hook names like `useAllProducts`.
  return cap(plural(name));
}

function humanise(name: string): string {
  // camelCase → "Camel Case".  The DSL guarantees workflow names are
  // valid identifiers (no spaces / punctuation), so a single regex
  // pass is sufficient.
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced[0]!.toUpperCase() + spaced.slice(1);
}

function typeLabel(t: import("../../ir/loom-ir.js").TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `Id<${t.targetName}>`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `${typeLabel(t.element)}[]`;
    case "optional":
      return `${typeLabel(t.inner)}?`;
  }
}

function zodForRequest(t: import("../../ir/loom-ir.js").TypeIR): string {
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
