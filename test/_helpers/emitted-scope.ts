// "Does the emitted code reference a name it never brought into scope?"
//
// This is the single most common way the generated-frontend build gates go
// red.  Of the 16 `main`-red events tracked on #2469, THIRTEEN were one
// instance of it: a paged `Table`'s pager chrome emitted `t("chrome.prev", …)`
// into a page that never imported `t`, so every generated project with a paged
// list and i18n on shipped a TS2304 (#2507).
//
// The reason it survived ten consecutive red sweeps is the shape worth
// remembering: it is a STATIC defect that only a COMPILER was looking for.
// `generated-react-build` compiles a 2-cell slice at PR time
// (`examples/showcase.ddd` × 2 packs) and the full 160-cell matrix only on
// `push: main`, so the introducing PR was green and the sweep was red
// afterwards — the workflow's own header calls this out ("Misses per-example
// drift").  No amount of merging `main` into the branch would have caught it:
// the failing cell is simply not in the PR gate's input set.
//
// But finding an unbound identifier never needed a type-checker.  Generating
// all 160 cells takes ~47s in-process (~294ms each); COMPILING them takes
// 60-90s per cell.  So the detection moves off the compiler and into the fast
// suite, where it runs per-PR over the whole matrix instead of post-merge over
// a slice.
//
// WHAT THIS DOES NOT DO.  It is a scope check, not a type check.  A prop-type
// mismatch, a DTO shape divergence, an arity error — none of those are visible
// here, and the `push: main` compile sweep remains the net for them.  This
// converts the most frequent failure mode into a per-PR check; it does not
// make the sweep redundant.

/** How each frontend names its page files, and the forms in which a page may
 *  legitimately bind the translate function.
 *
 *  The binding list is the load-bearing part: a check that only looked for
 *  `import { t }` would report every Angular page as broken, since Angular
 *  pages expose it as a class member instead. */
export interface FrontendScopeSpec {
  readonly framework: string;
  /** Files to inspect — the pages that render walker output. */
  readonly pages: RegExp;
}

export const FRONTEND_SCOPES: readonly FrontendScopeSpec[] = [
  { framework: "react", pages: /\/src\/pages\/.*\.tsx$/ },
  { framework: "vue", pages: /\/src\/pages\/.*\.vue$/ },
  { framework: "svelte", pages: /\+page\.svelte$/ },
  { framework: "angular", pages: /\/src\/app\/pages\/.*\.component\.ts$/ },
];

/** True when `content` brings `t` into scope by any of the legitimate routes.
 *
 *  - a named import — `import { t } from "…"` (react/vue/svelte)
 *  - an Angular class member — `protected readonly t = t`
 *  - a local alias — `const t = …`
 *
 *  Deliberately permissive: a FALSE PASS here costs one missed defect, while a
 *  false FAIL would fire on every page of a frontend whose binding form we did
 *  not anticipate and would get the whole gate disabled. */
export function bindsTranslate(content: string): boolean {
  return (
    /\bimport\s*\{[^}]*\bt\b[^}]*\}/.test(content) ||
    /\breadonly t = t\b/.test(content) ||
    /\b(?:const|let|var)\s+t\s*=/.test(content)
  );
}

/** Every page file that CALLS `t(` without binding it.  Returns the offending
 *  paths so a failure names them rather than just counting. */
export function unboundTranslateCalls(files: ReadonlyMap<string, string>, pages: RegExp): string[] {
  const bad: string[] = [];
  for (const [path, content] of files) {
    if (!pages.test(path)) continue;
    if (!/\bt\(/.test(content)) continue;
    if (!bindsTranslate(content)) bad.push(path);
  }
  return bad;
}

/** Page files that actually reached the translate runtime.
 *
 *  The vacuity guard.  `unboundTranslateCalls` returns `[]` both when every
 *  page is correct AND when nothing emitted a `t(` call at all — including
 *  when generation silently produced no pages.  A sweep that cannot tell those
 *  apart reports a comforting green for a broken harness, which is the exact
 *  failure mode `experience_gathered.md` §59/§63 keeps recording. */
export function translatingPages(files: ReadonlyMap<string, string>, pages: RegExp): string[] {
  return [...files]
    .filter(([path, content]) => pages.test(path) && /\bt\(/.test(content))
    .map(([path]) => path);
}
