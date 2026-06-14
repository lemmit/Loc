import type { PageIR } from "../../../ir/types/loom-ir.js";
import { typeUsesMoney } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import type { ImportSpec, LoadedPack } from "../../_packs/loader.js";
import type { OperationFormState, WalkResult } from "../../_walker/walker-core.js";
import { idTargetHookVar } from "../../react/form-helpers.js";
import { vueTarget } from "./vue-target.js";

// ---------------------------------------------------------------------------
// Vue page shell — assembles a generated `.vue` SFC around a walked
// page body.  The Vue analogue of `react/walker/page-shell.ts`, v1
// scope (vue-frontend-plan.md Slice 4):
//
//   - `<script setup lang="ts">` carries the api-composable hoists,
//     route-param reads, `ref()` state fields, and the `navigate`
//     adapter the walked markup references.
//   - api handles are wrapped in `reactive(...)`: vue-query returns
//     an object of nested Refs, and Vue templates only auto-unwrap
//     TOP-LEVEL refs — `customerAll.data` in a `v-if` would otherwise
//     be an always-truthy Ref.  `reactive()` deep-unwraps, so the
//     SAME rendered expression reads correctly in template and
//     script positions.  (This is the vue-query surface decision the
//     plan gates in this slice.)
//   - the walker emits `navigate("/path")` for `Button(to:)` — a
//     local `const navigate = (to: string) => { void router.push(to) }`
//     adapter keeps that contract without a new WalkerTarget seam.
//   - form wiring assembles from the FormOfState records: an
//     aggregate create-form gets the `form` LoomForm instance + the
//     `create` mutation handle the pack's primitive-form-of markup
//     references; each operation form gets a v-dialog appended after
//     the walked body, dialog state, an open-fn, and its own
//     `<op>Form` instance.  Workflow forms are the workflow parity
//     slice's TODO.
// ---------------------------------------------------------------------------

/** Everything the SFC assembler needs beyond the walk result. */
export interface VuePageShellInput {
  page: PageIR;
  /** Route params the page's route declares (`:id` → `id`). */
  routeParams: readonly string[];
  result: WalkResult;
  /** Active design pack — operation dialogs render through its
   *  `op-dialog` template so the modal markup stays pack-owned
   *  (v-dialog on vuetify, the ui Dialog components on shadcnVue). */
  pack: LoadedPack;
}

export function renderVuePage(input: VuePageShellInput): string {
  const { page, routeParams, result } = input;
  const script: string[] = [];
  const vueImports = new Set<string>();

  // Route params — `const id = computed(() => route.params.id as string)`
  // would be the reactive form, but walker-rendered expressions read
  // the bare name (`id`), so bind plain consts off `useRoute()`; a
  // param change remounts via the router's default behaviour for
  // generated CRUD pages.
  // Form wiring (the reactive()+zod runtime, D-VUE-FRONTEND):
  //   - an aggregate create-form gets `const form = useLoomForm(...)`
  //     + the `create` mutation handle the pack's primitive-form-of
  //     markup references;
  //   - each operation form gets a v-dialog appended after the walked
  //     body, an open-fn the trigger button calls, its own
  //     `<op>Form` instance, and the mutation handle.
  const opFormLines: string[] = [];
  const opFormStates = result.formOfs.filter(
    (f): f is OperationFormState => f.kind === "operation",
  );
  const aggFormState = result.formOfs.find((f) => f.kind === "aggregate");
  const wfFormState = result.formOfs.find((f) => f.kind === "workflow");
  const usesLoomForm =
    aggFormState !== undefined || wfFormState !== undefined || opFormStates.length > 0;
  // Create + workflow forms' default submit bodies navigate.
  const needsNavigate =
    result.usesNavigate || aggFormState !== undefined || wfFormState !== undefined;
  const idExprParams = new Set<string>();
  for (const state of opFormStates) {
    for (const p of routeParams) {
      if (state.idExpr.includes(p)) idExprParams.add(p);
    }
  }

  const usedParams = [
    ...new Set([...[...result.usedParams].filter((p) => routeParams.includes(p)), ...idExprParams]),
  ];
  const needsRoute = usedParams.length > 0;

  // State fields — `ref()` per declared field; the walked markup
  // reads bare names (template auto-unwrap) per vueTarget.
  const stateLines: string[] = [];
  if (result.usesState) {
    for (const f of page.state) {
      stateLines.push(`const ${f.name} = ref(${vueTarget.defaultInitFor(f.type)});`);
      // The shared input primitives' VM carries the React-style
      // `set<Pascal>` setter name (`@update:model-value` callbacks in
      // the vue packs call it) — provide it as a plain function.
      const pascal = f.name[0]!.toUpperCase() + f.name.slice(1);
      stateLines.push(
        `const set${pascal} = (v: typeof ${f.name}.value) => { ${f.name}.value = v; };`,
      );
      vueImports.add("ref");
    }
  }

  // Api-composable hoists, deduped by var name; `reactive()` wrapper
  // per the header note.
  const hookLines: string[] = [];
  const apiImports = new Map<string, Set<string>>();
  const seenVars = new Set<string>();
  // Hoisted hook args were rendered at WALK time (template-position
  // forms: state refs are bare names) but the hoist line lives in
  // SCRIPT position — re-point state-field reads at `.value`.  Plain
  // captured values, not reactive inputs: a vue filter input doesn't
  // live-refetch yet (the api module would need MaybeRefOrGetter
  // params — tracked as a parity follow-up).
  const stateNames = new Set(page.state.map((f) => f.name));
  const scriptArgs = (rendered: readonly string[]): string =>
    rendered
      .map((a) => {
        let out = a;
        for (const n of stateNames) {
          out = out.replace(new RegExp(`\\b${n}\\b(?!\\.value)`, "g"), `${n}.value`);
        }
        return out;
      })
      .join(", ");
  for (const use of result.usedApiHooks.values()) {
    if (seenVars.has(use.varName)) continue;
    seenVars.add(use.varName);
    const args = scriptArgs(use.argsRendered ?? []);
    hookLines.push(`const ${use.varName} = reactive(${use.hookName}(${args}));`);
    vueImports.add("reactive");
    const names = apiImports.get(use.importFrom) ?? new Set<string>();
    names.add(use.hookName);
    apiImports.set(use.importFrom, names);
  }
  // Aggregate create-form wiring — the pack's primitive-form-of
  // markup references `form` (the LoomForm instance) and `create`
  // (the mutation handle); its default submit body navigates.
  if (aggFormState && aggFormState.kind === "aggregate") {
    const agg = aggFormState.agg.name;
    if (!seenVars.has("create")) {
      seenVars.add("create");
      opFormLines.push(`const create = reactive(useCreate${agg}());`);
      vueImports.add("reactive");
    }
    opFormLines.push(
      `const form = useLoomForm(Create${agg}Request, ${aggFormState.defaultValuesTs});`,
    );
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`useCreate${agg}`);
    names.add(`Create${agg}Request`);
    apiImports.set(from, names);
  }
  // Workflow run-form wiring — the pack markup references `form` +
  // `run` (the workflow mutation handle); default submit navigates
  // to /workflows.  Mutually exclusive with an aggregate form on the
  // same page in practice (one `form` instance per page).
  if (wfFormState && wfFormState.kind === "workflow") {
    const wf = upperFirst(wfFormState.workflow.name);
    if (!seenVars.has("run")) {
      seenVars.add("run");
      opFormLines.push(`const run = reactive(use${wf}Workflow());`);
      vueImports.add("reactive");
    }
    opFormLines.push(`const form = useLoomForm(${wf}Request, ${wfFormState.defaultValuesTs});`);
    const from = "../api/workflows";
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(`use${wf}Workflow`);
    names.add(`${wf}Request`);
    apiImports.set(from, names);
  }
  // Operation forms — dialog state + open-fn + per-op LoomForm.
  const dialogBlocks: string[] = [];
  for (const state of opFormStates) {
    if (state.kind !== "operation") continue;
    const opCamel = lowerFirst(state.op.name);
    const opPascal = upperFirst(state.op.name);
    const agg = state.agg.name;
    const from = `../api/${lowerFirst(agg)}`;
    const names = apiImports.get(from) ?? new Set<string>();
    if (!seenVars.has(opCamel)) {
      seenVars.add(opCamel);
      const hookName = `use${opPascal}${agg}`;
      opFormLines.push(`const ${opCamel} = reactive(${hookName}(${state.idExpr}));`);
      vueImports.add("reactive");
      names.add(hookName);
    }
    const openFn = `open${opPascal}Modal`;
    if (seenVars.has(openFn)) {
      apiImports.set(from, names);
      continue;
    }
    seenVars.add(openFn);
    names.add(`${opPascal}${agg}Request`);
    apiImports.set(from, names);
    opFormLines.push(`const ${opCamel}Open = ref(false);`);
    vueImports.add("ref");
    opFormLines.push(`const ${openFn} = (_mut: unknown) => { ${opCamel}Open.value = true; };`);
    opFormLines.push(
      `const ${opCamel}Form = useLoomForm(${opPascal}${agg}Request, ${state.defaultValuesTs});`,
    );
    // Field markup was walked with the create-form instance name
    // (`form.`) — re-point it at this dialog's instance.  Provisional
    // until the field VM carries a `formVar` slot.
    const fields = state.fieldHtmls
      .map((h) => h.replaceAll("form.values.", `${opCamel}Form.values.`))
      .map((h) => h.replaceAll("form.errors[", `${opCamel}Form.errors[`))
      .map((h) => `            ${h}`)
      .join("\n");
    const ns = state.testidNamespace;
    dialogBlocks.push(
      input.pack.render("op-dialog", {
        openVar: `${opCamel}Open`,
        formVar: `${opCamel}Form`,
        mutVar: opCamel,
        title: humanize(state.op.name),
        submitLabel: humanize(state.op.name),
        ns,
        fieldsHtml: fields,
      }),
    );
    // The dialog template's component imports (pack.json
    // `imports["op-dialog"]`) merge into the page's import lines —
    // the walk never sees this template, so the walker's ImportMap
    // can't carry them.
    for (const spec of (input.pack.manifest.imports?.["op-dialog"] ?? []) as ImportSpec[]) {
      const names = result.imports.get(spec.from) ?? new Set<string>();
      for (const n of spec.named) names.add(n);
      result.imports.set(spec.from, names);
    }
  }
  // Id-target lookup hooks (`X id` form fields render as selects fed
  // by `useAll<Target>()` — the field templates reference the
  // `idTargetHookVar` name baked in at walk time), deduped across
  // all form states.
  for (const state of result.formOfs) {
    for (const t of state.idTargets) {
      const hookVar = idTargetHookVar(t);
      if (seenVars.has(hookVar)) continue;
      seenVars.add(hookVar);
      opFormLines.push(`const ${hookVar} = reactive(useAll${plural(t.name)}());`);
      vueImports.add("reactive");
      const from = `../api/${lowerFirst(t.name)}`;
      const names = apiImports.get(from) ?? new Set<string>();
      names.add(`useAll${plural(t.name)}`);
      apiImports.set(from, names);
    }
  }
  // `Action(<inst>.<op>)` mutation hoists — same reactive() wrapper.
  for (const m of result.actionMutations) {
    if (seenVars.has(m.localVar)) continue;
    seenVars.add(m.localVar);
    hookLines.push(`const ${m.localVar} = reactive(${m.hookName}());`);
    vueImports.add("reactive");
    const from = `../api/${m.aggCamel}`;
    const names = apiImports.get(from) ?? new Set<string>();
    names.add(m.hookName);
    apiImports.set(from, names);
  }

  // --- script assembly, imports first -------------------------------------
  if (vueImports.size > 0) {
    script.push(`import { ${[...vueImports].sort().join(", ")} } from "vue";`);
  }
  // A money-typed `state {}` field refs as `ref(new Decimal("0"))` —
  // pull decimal.js into the <script setup> (the dep rides the
  // deployable's money-usage flag in package.json).
  if (result.usesState && page.state.some((f) => typeUsesMoney(f.type))) {
    script.push(`import Decimal from "decimal.js";`);
  }
  if (needsRoute && needsNavigate) {
    script.push(`import { useRoute, useRouter } from "vue-router";`);
  } else if (needsRoute) {
    script.push(`import { useRoute } from "vue-router";`);
  } else if (needsNavigate) {
    script.push(`import { useRouter } from "vue-router";`);
  }
  // Format helpers — imported unconditionally (generated tsconfig
  // keeps noUnusedLocals off, mirroring the React project) so pack
  // templates can call them without an import-registration channel.
  script.push(
    `import { EMPTY, formatBool, formatDateTime, formatMoney, formatNumber, formatPlain, isEmpty, shortId } from "${relPrefix(input)}lib/format";`,
  );
  if (usesLoomForm) {
    script.push(`import { useLoomForm } from "${relPrefix(input)}lib/form";`);
  }
  for (const [from, names] of [...apiImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const adjusted = adjustDepth(from, input);
    script.push(`import { ${[...names].sort().join(", ")} } from "${adjusted}";`);
  }
  // Pack-declared per-primitive imports (pack.json `imports` tables) —
  // shadcnVue's ui-component barrel (`@/components/ui`) flows in here;
  // packs with globally-registered components (vuetify) declare none.
  // `@/` specifiers resolve through the pack's vite/tsconfig alias and
  // need no depth adjustment.
  //
  // The shared walker also drops React-pipeline imports into the same
  // sink (`react-hook-form` / `@hookform/resolvers/zod` from
  // `prepareFormFields`, plus un-depth-adjusted `../api/<agg>` request
  // imports the Vue shell already hoists itself via `apiImports`).
  // Those are TSX-shell concerns — emitting them here produces
  // duplicate identifiers and unresolvable modules — so only
  // non-relative, non-RHF specifiers pass through.
  const walkerInternalSources = new Set(["react-hook-form", "@hookform/resolvers/zod"]);
  for (const [from, names] of [...result.imports.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (names.size === 0) continue;
    if (walkerInternalSources.has(from) || from.startsWith("./") || from.startsWith("../")) {
      continue;
    }
    script.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  script.push("");
  if (needsRoute) {
    script.push("const route = useRoute();");
    for (const p of usedParams) {
      script.push(`const ${p} = route.params.${p} as string;`);
    }
  }
  if (needsNavigate) {
    script.push("const router = useRouter();");
    // The walker's `Button(to:)` contract (and the create-form's
    // default redirect) reference a bare `navigate(path)` — adapt it
    // onto vue-router locally.
    script.push("const navigate = (to: string) => { void router.push(to); };");
  }
  script.push(...stateLines);
  script.push(...hookLines);
  script.push(...opFormLines);
  if (result.usedUserComponents.size > 0) {
    script.push(
      `// TODO(vue-components): user components not yet supported by the Vue walker (${[...result.usedUserComponents].join(", ")})`,
    );
  }
  // Trim trailing blanks.
  while (script.length > 0 && script[script.length - 1] === "") script.pop();

  const title = humanize(page.name);
  const dialogs = dialogBlocks.length > 0 ? `\n${dialogBlocks.join("\n")}` : "";
  return `<!-- Auto-generated.  Do not edit by hand.  (${title}) -->
<script setup lang="ts">
${script.join("\n")}
</script>

<template>
${indent(result.tsx, "  ")}${dialogs}
</template>
`;
}

/** Relative prefix from the page's emit dir up to `src/` —
 *  `src/pages/x.vue` → `../`; `src/pages/orders/list.vue` → `../../`. */
function relPrefix(input: VuePageShellInput): string {
  const depth = pageDirDepth(input.page);
  return "../".repeat(depth);
}

/** Adjust an `ApiHookUse.importFrom` (recorded as `../api/<agg>` —
 *  the one-level-deep convention) to the page's actual directory
 *  depth. */
function adjustDepth(importFrom: string, input: VuePageShellInput): string {
  const depth = pageDirDepth(input.page);
  if (!importFrom.startsWith("../")) return importFrom;
  return "../".repeat(depth) + importFrom.slice(3);
}

function pageDirDepth(page: PageIR): number {
  const path = page.emitPath
    ? page.emitPath.replace(/\.tsx$/, ".vue")
    : `src/pages/${snake(page.name)}.vue`;
  // segments under src/ minus the filename = number of `../` hops
  // back to src/.
  return path.replace(/^src\//, "").split("/").length - 1;
}

function indent(markup: string, prefix: string): string {
  return markup
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}
