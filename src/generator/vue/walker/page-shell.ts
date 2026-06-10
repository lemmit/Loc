import type { PageIR } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, snake, upperFirst } from "../../../util/naming.js";
import type { WalkResult } from "../../_walker/walker-core.js";
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
//   - form wiring (`formOfs`) is NOT assembled yet — the reactive()+
//     zod forms runtime is the next sub-slice; pages that walked a
//     Form primitive carry the pack's TODO placeholder markup and a
//     script-side TODO marker.
// ---------------------------------------------------------------------------

/** Everything the SFC assembler needs beyond the walk result. */
export interface VuePageShellInput {
  page: PageIR;
  /** Route params the page's route declares (`:id` → `id`). */
  routeParams: readonly string[];
  result: WalkResult;
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
  // Operation-form trigger wiring (`openUpdateModal(update)` in the
  // walked markup) references hook handles + open-fns the React shell
  // gets from its form runtime.  Until the Vue forms runtime lands,
  // declare the hook handle (real — the mutation exists) and a
  // TODO-alert open-fn so the page compiles and the gap is visible
  // at click time rather than build time.
  const opFormLines: string[] = [];
  const opFormStates = result.formOfs.filter((f) => f.kind === "operation");
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
      vueImports.add("ref");
    }
  }

  // Api-composable hoists, deduped by var name; `reactive()` wrapper
  // per the header note.
  const hookLines: string[] = [];
  const apiImports = new Map<string, Set<string>>();
  const seenVars = new Set<string>();
  for (const use of result.usedApiHooks.values()) {
    if (seenVars.has(use.varName)) continue;
    seenVars.add(use.varName);
    const args = (use.argsRendered ?? []).join(", ");
    hookLines.push(`const ${use.varName} = reactive(${use.hookName}(${args}));`);
    vueImports.add("reactive");
    const names = apiImports.get(use.importFrom) ?? new Set<string>();
    names.add(use.hookName);
    apiImports.set(use.importFrom, names);
  }
  for (const state of opFormStates) {
    const opCamel = lowerFirst(state.op.name);
    const opPascal = upperFirst(state.op.name);
    if (!seenVars.has(opCamel)) {
      seenVars.add(opCamel);
      const hookName = `use${opPascal}${state.agg.name}`;
      opFormLines.push(`const ${opCamel} = reactive(${hookName}(${state.idExpr}));`);
      vueImports.add("reactive");
      const from = `../api/${lowerFirst(state.agg.name)}`;
      const names = apiImports.get(from) ?? new Set<string>();
      names.add(hookName);
      apiImports.set(from, names);
    }
    const openFn = `open${opPascal}Modal`;
    if (!seenVars.has(openFn)) {
      seenVars.add(openFn);
      opFormLines.push(
        `const ${openFn} = (_mut: unknown) => { window.alert("TODO(vue-forms): the ${opPascal} form lands with the Vue forms runtime"); };`,
      );
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
  if (needsRoute && result.usesNavigate) {
    script.push(`import { useRoute, useRouter } from "vue-router";`);
  } else if (needsRoute) {
    script.push(`import { useRoute } from "vue-router";`);
  } else if (result.usesNavigate) {
    script.push(`import { useRouter } from "vue-router";`);
  }
  // Format helpers — imported unconditionally (generated tsconfig
  // keeps noUnusedLocals off, mirroring the React project) so pack
  // templates can call them without an import-registration channel.
  script.push(
    `import { EMPTY, formatBool, formatDateTime, formatMoney, formatNumber, formatPlain, isEmpty, shortId } from "${relPrefix(input)}lib/format";`,
  );
  for (const [from, names] of [...apiImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const adjusted = adjustDepth(from, input);
    script.push(`import { ${[...names].sort().join(", ")} } from "${adjusted}";`);
  }
  script.push("");
  if (needsRoute) {
    script.push("const route = useRoute();");
    for (const p of usedParams) {
      script.push(`const ${p} = route.params.${p} as string;`);
    }
  }
  if (result.usesNavigate) {
    script.push("const router = useRouter();");
    // The walker's `Button(to:)` contract references a bare
    // `navigate(path)` — adapt it onto vue-router locally.
    script.push("const navigate = (to: string) => { void router.push(to); };");
  }
  script.push(...stateLines);
  script.push(...hookLines);
  script.push(...opFormLines);
  if (result.formOfs.some((f) => f.kind !== "operation")) {
    script.push("// TODO(vue-forms): form wiring lands with the reactive()+zod forms runtime");
  }
  if (result.usedUserComponents.size > 0) {
    script.push(
      `// TODO(vue-components): user components not yet supported by the Vue walker (${[...result.usedUserComponents].join(", ")})`,
    );
  }
  // Trim trailing blanks.
  while (script.length > 0 && script[script.length - 1] === "") script.pop();

  const title = humanize(page.name);
  return `<!-- Auto-generated.  Do not edit by hand.  (${title}) -->
<script setup lang="ts">
${script.join("\n")}
</script>

<template>
${indent(result.tsx, "  ")}
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
