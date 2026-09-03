// ---------------------------------------------------------------------------
// Diagnostic code → language-reference anchor (M-T8.18).
//
// The playground's Problems rows link every `loom.*` code to the chapter
// section that documents the construct it complains about, so an error is a
// door into the reference instead of a dead end (audit H7).  A code with no
// entry renders NO link — never a 404 — and the set of such codes is pinned
// as a ratchet by `test/system/diagnostic-docs-anchors.test.ts`, which also
// checks every anchor below against the headings actually in `docs/`.
//
// Anchors are GitHub-style heading slugs (`githubHeadingSlug`) — the same
// rule `docs/build.mjs` stamps on the rendered site's headings, so one link
// works on GitHub and on the docs site.  Paths are relative to `docs/`.
//
// Pure, import-free leaf like its sibling `messages.ts`: consumed by the
// browser playground, so it must stay Node-free.
// ---------------------------------------------------------------------------

/** GitHub's heading-anchor rule: lowercase, drop everything but letters,
 *  digits, spaces, hyphens and underscores, then turn each space into a
 *  hyphen (two spaces around an em dash become two hyphens — GitHub keeps
 *  them, so we do too). */
export function githubHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The docs root every entry is relative to (the published site). */
export const DOCS_SITE = "https://lemmit.github.io/Loc/";

const CHAPTER_DIR = "language-reference";

/** code → `<chapter>.md#<anchor>`, grouped by chapter.  Only codes whose
 *  construct has a documented section; extend it as the reference grows (the
 *  ratchet test then asks you to drop the code from its undocumented list). */
export const CODE_DOCS_ANCHORS: Readonly<Record<string, string>> = {
  "loom.duplicate-theme-block": "02-systems-and-topology.md#theme",
  "loom.entity-field-modifier": "03-domain-modeling.md#entity-parts--contains",
  "loom.entity-field-optional-collection": "04-type-system.md#collections--t",
  "loom.generic-arg-not-carrier": "04-type-system.md#generic-carriers--paged-envelope-option",
  "loom.generic-position": "04-type-system.md#generic-carriers--paged-envelope-option",
  "loom.token-nullable": "04-type-system.md#options--t",
  "loom.bare-aggregate-in-type": "04-type-system.md#x-id--cross-aggregate-references",
  "loom.unknown-name": "05-expressions.md#member-access--calls",
  "loom.applier-on-non-event-sourced":
    "06-behavior-and-statements.md#applye-event--the-event-sourcing-fold",
  "loom.reserved-derived-on-vo": "07-invariants-derived-functions.md#reserved-display-and-inspect",
  "loom.abstract-aggregate-behavior":
    "08-inheritance-and-polymorphism.md#abstract-aggregate--the-base",
  "loom.abstract-repository": "08-inheritance-and-polymorphism.md#abstract-aggregate--the-base",
  "loom.polymorphic-id-ref-unsupported":
    "08-inheritance-and-polymorphism.md#base-id-references--tph-only",
  "loom.extends-non-abstract": "08-inheritance-and-polymorphism.md#extends--a-concrete-subtype",
  "loom.extends-self": "08-inheritance-and-polymorphism.md#extends--a-concrete-subtype",
  "loom.es-tph-forced-own-table":
    "08-inheritance-and-polymorphism.md#inheritanceusing---the-storage-strategy",
  "loom.inheritance-modifier-misplaced":
    "08-inheritance-and-polymorphism.md#inheritanceusing---the-storage-strategy",
  "loom.union-duplicate-variant": "09-payloads-and-unions.md#anonymous-union--a-or-b",
  "loom.union-position": "09-payloads-and-unions.md#anonymous-union--a-or-b",
  "loom.union-variant-not-carrier": "09-payloads-and-unions.md#anonymous-union--a-or-b",
  "loom.unmapped-error-status":
    "09-payloads-and-unions.md#error--httpstatus--exception-less-problemdetails",
  "loom.criterion-impure": "10-repositories-and-queries.md#criterion",
  "loom.projection-aggregate-arg-not-columnar":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-join-invalid":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-key-not-columnar":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-keyed-invalid":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-missing": "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-no-aggregate":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-select-not-grouped":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-groupby-source-invalid":
    "10-repositories-and-queries.md#grouped-projection--group-by",
  "loom.projection-fields-without-select":
    "10-repositories-and-queries.md#shorthand-projection--the-select-less-form",
  "loom.projection-shorthand-nonaggregate":
    "10-repositories-and-queries.md#shorthand-projection--the-select-less-form",
  "loom.find-where-column-column": "10-repositories-and-queries.md#the-queryable-subset",
  "loom.find-where-not-queryable": "10-repositories-and-queries.md#the-queryable-subset",
  "loom.find-where-unknown-field": "10-repositories-and-queries.md#the-queryable-subset",
  "loom.retrieval-where-not-queryable": "10-repositories-and-queries.md#the-queryable-subset",
  "loom.projection-columnless-source":
    "10-repositories-and-queries.md#the-source-has-to-have-columns",
  "loom.projection-document-source-capability-filtered":
    "10-repositories-and-queries.md#the-source-has-to-have-columns",
  "loom.projection-groupby-unsupported-backend":
    "10-repositories-and-queries.md#the-source-has-to-have-columns",
  "loom.projection-whole-table-aggregation-unsupported":
    "10-repositories-and-queries.md#the-source-has-to-have-columns",
  "loom.ignoring-clause-placement":
    "10-repositories-and-queries.md#where-the-clause-may-be-written",
  "loom.context-filter-unsupported":
    "11-capabilities-filters-stamps.md#filter-expr--a-predicate-and-ed-into-every-read",
  "loom.self-outside-capability":
    "11-capabilities-filters-stamps.md#self-id--self-reference-inside-a-capability",
  "loom.workflow-load-array-unsupported": "13-workflows.md#body-vocabulary",
  "loom.workflow-private-operation": "13-workflows.md#body-vocabulary",
  "loom.workflow-unrecognised-statement": "13-workflows.md#body-vocabulary",
  "loom.canonical-create-duplicate-workflow":
    "13-workflows.md#create--handle--starters--continuations",
  "loom.create-name-conflict-workflow": "13-workflows.md#create--handle--starters--continuations",
  "loom.workflow-applier-on-non-event-sourced":
    "13-workflows.md#create--handle--starters--continuations",
  "loom.correlation-type-mismatch": "13-workflows.md#one-event--the-event-reactor",
  "loom.correlation-uninferrable": "13-workflows.md#one-event--the-event-reactor",
  "loom.reactor-event-uncarried": "13-workflows.md#one-event--the-event-reactor",
  "loom.resource-op-in-transaction": "13-workflows.md#resource-consumption",
  "loom.resource-verb-invalid": "13-workflows.md#resource-consumption",
  "loom.isolation-requires-transactional": "13-workflows.md#transactional--isolation",
  "loom.transactional-no-effect": "13-workflows.md#transactional--isolation",
  "loom.correlation-field-ambiguous": "13-workflows.md#workflow--state",
  "loom.workflow-correlation-required": "13-workflows.md#workflow--state",
  "loom.channel-key-missing-field": "14-apis-storage-resources-channels.md#channel--channelsource",
  "loom.reserved-not-emitted": "14-apis-storage-resources-channels.md#connection-sources",
  "loom.channelsource-incompatible":
    "14-apis-storage-resources-channels.md#transport-compatibility",
  "loom.relay-target-not-subscribed":
    "14-apis-storage-resources-channels.md#transport-compatibility",
  "loom.component-missing-body": "15-ui-pages-structure.md#component--reusable-region-tree",
  "loom.action-out-of-position": "15-ui-pages-structure.md#state--derived--action",
  "loom.effect-in-lambda": "15-ui-pages-structure.md#state--derived--action",
  "loom.angular-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.feliz-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.flutter-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.react-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.svelte-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.ui-framework-unhostable": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.vue-deployable-missing-ui": "15-ui-pages-structure.md#ui-block--deployable-binding",
  "loom.chart-accessor-not-field":
    "16-ui-walker-primitives.md#chart--grouped-projection-series-every-frontend",
  "loom.chart-of-not-grouped":
    "16-ui-walker-primitives.md#chart--grouped-projection-series-every-frontend",
  "loom.chart-unsupported-target":
    "16-ui-walker-primitives.md#chart--grouped-projection-series-every-frontend",
  "loom.bindable-input-value-arg": "16-ui-walker-primitives.md#createform--the-form-family",
  "loom.auth-missing-issuer": "17-auth.md#auth-----oidc-config",
  "loom.auth-unknown-claim-field": "17-auth.md#auth-----oidc-config",
  "loom.auth-without-user": "17-auth.md#auth-required--per-deployable-middleware--verifier-seam",
  "loom.currentuser-not-in-request-scope": "17-auth.md#currentuser--claim-access-in-domain-logic",
  "loom.workflow-currentuser-find": "17-auth.md#currentuser--claim-access-in-domain-logic",
  "loom.auth-unknown-provider": "17-auth.md#errors",
  "loom.duplicate-permission": "17-auth.md#permissions--a-typed-catalogue",
  "loom.unknown-permission": "17-auth.md#permissions--a-typed-catalogue",
  "loom.default-deny-ungated": "17-auth.md#requires--the-authorization-gate-http-403",
  "loom.sensitive-wire-unsupported": "17-auth.md#sensitive--field-tagging",
  "loom.duplicate-user-block": "17-auth.md#user--the-jwt-claim-shape",
  "loom.user-duplicate-field": "17-auth.md#user--the-jwt-claim-shape",
  "loom.aggregate-test-context": "18-testing.md#test---an-in-process-unit-test",
  "loom.test-redundant-for": "18-testing.md#test---an-in-process-unit-test",
  "loom.e2e-unsupported-statement":
    "18-testing.md#test-e2e--against-deployable--a-live-end-to-end-test",
  "loom.extern-component-has-body": "21-externs.md#extern-component",
  "loom.extern-function-shadows-stdlib": "21-externs.md#extern-function",
  "loom.seed-duplicate-field": "23-domain-services-and-seeds.md#seed--declarative-first-boot-data",
  "loom.seed-foreign-aggregate":
    "23-domain-services-and-seeds.md#seed--declarative-first-boot-data",
  "loom.domain-service-no-emit":
    "23-domain-services-and-seeds.md#the-no-infra-contract-phase-⑦-ir-validator",
  "loom.domain-service-no-mutation":
    "23-domain-services-and-seeds.md#the-no-infra-contract-phase-⑦-ir-validator",
  "loom.domain-service-no-workflow-start":
    "23-domain-services-and-seeds.md#the-no-infra-contract-phase-⑦-ir-validator",
  "loom.domain-service-single-aggregate":
    "23-domain-services-and-seeds.md#the-no-infra-contract-phase-⑦-ir-validator",
  "loom.seed-abstract-aggregate": "23-domain-services-and-seeds.md#what-a-seed-row-may-not-be",
  "loom.seed-dataset-name-collision": "23-domain-services-and-seeds.md#what-a-seed-row-may-not-be",
  "loom.seed-event-sourced-unsupported":
    "23-domain-services-and-seeds.md#what-a-seed-row-may-not-be",
  "loom.seed-raw-document-shape": "23-domain-services-and-seeds.md#what-a-seed-row-may-not-be",
  "loom.seed-tenant-owned-needs-raw": "23-domain-services-and-seeds.md#what-a-seed-row-may-not-be",
};

/** The docs path for a diagnostic code, relative to the docs root —
 *  `language-reference/04-type-system.md#x-id--cross-aggregate-references` —
 *  or `undefined` when the code has no documented anchor (render no link). */
export function codeDocsPath(code: string): string | undefined {
  const rel = CODE_DOCS_ANCHORS[code];
  return rel === undefined ? undefined : `${CHAPTER_DIR}/${rel}`;
}

/** Absolute URL on the published docs site (`.md` → `.html`, as
 *  `docs/build.mjs` rewrites links), or `undefined` when undocumented. */
export function codeDocsUrl(code: string, site: string = DOCS_SITE): string | undefined {
  const rel = codeDocsPath(code);
  if (rel === undefined) return undefined;
  const [file, anchor] = rel.split("#");
  return `${site}${file.replace(/\.md$/, ".html")}${anchor ? `#${anchor}` : ""}`;
}
