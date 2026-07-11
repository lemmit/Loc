import type { AstNode } from "langium";
import {
  readArgBoolLiteral,
  readArgInt,
  readArgRef,
  readArgRefs,
  readArgString,
} from "../../macros/api/_read.js";
import type {
  ActionDecl,
  Aggregate,
  Api,
  AuthBlock,
  AuthConfigValue,
  BindEntry,
  BoundedContext,
  Component,
  ComponentDecl,
  Containment,
  ContextMember,
  Deployable,
  DerivedProp,
  EntityPart,
  EnumDecl,
  EventDecl,
  FindDecl,
  FunctionDecl,
  Invariant,
  Layout,
  LayoutNamedSlot,
  MenuBlock,
  MenuLink,
  MenuSection,
  OnDecl,
  Operation,
  Page,
  PageProp,
  Parameter,
  PermissionsBlock,
  Property,
  Repository,
  Requirement,
  Solution,
  StateBlock,
  Statement,
  Storage,
  Subdomain,
  System,
  TestBlock,
  TestCase,
  TestE2E,
  TestStatement,
  ThemeBlock,
  TypeRef,
  Ui,
  UiApiParam,
  UserBlock,
  ValueObject,
  View,
  Workflow,
} from "../generated/ast.js";
import { printExpr } from "./print-expr.js";
import { printStmt } from "./print-stmt.js";

// ---------------------------------------------------------------------------
// AST → `.ddd` source printer for *structural* constructs — systems, modules,
// aggregates, value objects, events, repositories, views, workflows,
// deployables, storages, apis, ui blocks, and the traceability artefacts.
//
// Companion to `print-expr.ts` / `print-stmt.ts` (which handle expressions and
// statement bodies, invoked here for derived props, filters, operation bodies,
// page bodies, etc.).  The System / Model Builder edits the structural model
// visually and writes the changed block back over its CST range; this re-emits
// a structural sub-tree as faithful source.
//
// Round-trip contract (gated by test/print-structural-roundtrip.test.ts):
// printing a node, splicing the text over the node's own CST range, and
// re-parsing yields a structurally identical AST.  Output is canonically
// 2-space-indented; only parse-equivalence is guaranteed, not byte identity
// with the original source.
// ---------------------------------------------------------------------------

const INDENT = "  ";

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? INDENT + l : l))
    .join("\n");
}

/** `<header> { <body-items, newline-joined> }`, indented; `<header> {}` empty. */
function block(header: string, items: string[]): string {
  if (items.length === 0) return `${header} {}`;
  return `${header} {\n${indent(items.join("\n"))}\n}`;
}

/** Like `block`, but the body items are comma-separated (enum values, event
 *  fields, permission decls — grammar rules that join with `,`). */
function commaBlock(header: string, items: string[]): string {
  if (items.length === 0) return `${header} {}`;
  return `${header} {\n${indent(items.join(",\n"))}\n}`;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

// These mirror the grammar's `Platform` / `DesignPack` datatype-rule keyword
// alternatives (src/language/ddd.langium).  A keyword prints bare; anything
// else came from the `STRING` alternative and re-quotes.  Kept honest by
// `print-keyword-mirrors.test.ts`, which derives the expected sets straight
// from the parsed grammar (the `walker-stdlib` pattern) — a stale entry here
// (missing platform/pack, or a retired keyword) fails CI (C6).
export const PLATFORM_KEYWORDS: ReadonlySet<string> = new Set([
  "dotnet",
  "node",
  "react",
  "svelte",
  "vue",
  "angular",
  "static",
  "elixir",
  "python",
  "java",
]);
export const DESIGN_KEYWORDS: ReadonlySet<string> = new Set([
  "mantine",
  "shadcn",
  "mui",
  "chakra",
  "coreComponents",
  "daisyui",
  "shadcnSvelte",
  "flowbite",
  "vuetify",
  "shadcnVue",
  "angularMaterial",
  "primeng",
  "spartanNg",
]);

/** Platform / DesignPack are `keyword | STRING` rules: print a known keyword
 *  bare, otherwise re-quote (the value came from the STRING alternative). */
function enumOrString(value: string, keywords: ReadonlySet<string>): string {
  return keywords.has(value) ? value : quote(value);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Print any structural AST node back to `.ddd` source. */
export function printStructural(node: AstNode): string {
  switch (node.$type) {
    case "System":
      return printSystem(node as System);
    case "Subdomain":
      return printSubdomain(node as Subdomain);
    case "Deployable":
      return printDeployable(node as Deployable);
    case "ThemeBlock":
      return printThemeBlock(node as ThemeBlock);
    case "UserBlock":
      return printUserBlock(node as UserBlock);
    case "AuthBlock":
      return printAuthBlock(node as AuthBlock);
    case "TenancyDecl":
      return printTenancyDecl(node as import("../generated/ast.js").TenancyDecl);
    case "TestE2E":
      return printTestE2E(node as TestE2E);
    case "Ui":
      return printUi(node as Ui);
    case "Api":
      return printApi(node as Api);
    case "Storage":
      return printStorage(node as Storage);
    case "Resource":
      return printDataSource(node as import("../generated/ast.js").Resource);
    case "Layout":
      return printLayout(node as Layout);
    case "Capability":
      return printCapability(node as import("../generated/ast.js").Capability);
    case "BoundedContext":
      return printBoundedContext(node as BoundedContext);
    case "EnumDecl":
      return printEnumDecl(node as EnumDecl);
    case "ValueObject":
      return printValueObject(node as ValueObject);
    case "Aggregate":
      return printAggregate(node as Aggregate);
    case "EventDecl":
      return printEventDecl(node as EventDecl);
    case "PayloadDecl":
      return printPayloadDecl(node as import("../generated/ast.js").PayloadDecl);
    case "Channel":
      return printChannel(node as import("../generated/ast.js").Channel);
    case "ChannelSource":
      return printChannelSource(node as import("../generated/ast.js").ChannelSource);
    case "Repository":
      return printRepository(node as Repository);
    case "Workflow":
      return printWorkflow(node as Workflow);
    case "Projection":
      return printProjection(node as import("../generated/ast.js").Projection);
    case "View":
      return printView(node as View);
    case "Requirement":
      return printRequirement(node as Requirement);
    case "Solution":
      return printSolution(node as Solution);
    case "TestCase":
      return printTestCase(node as TestCase);
    case "EntityPart":
      return printEntityPart(node as EntityPart);
    case "Operation":
      return printOperation(node as Operation);
    case "CommandHandler":
      return printCommandHandler(node as import("../generated/ast.js").CommandHandler);
    case "QueryHandler":
      return printQueryHandler(node as import("../generated/ast.js").QueryHandler);
    case "Create":
      return printCreate(node as import("../generated/ast.js").Create);
    case "Destroy":
      return printDestroy(node as import("../generated/ast.js").Destroy);
    case "Apply":
      return printApply(node as import("../generated/ast.js").Apply);
    case "FunctionDecl":
      return printFunctionDecl(node as FunctionDecl);
    case "DerivedProp":
      return printDerivedProp(node as DerivedProp);
    case "Invariant":
      return printInvariant(node as Invariant);
    case "Unique":
      return printUnique(node as import("../generated/ast.js").Unique);
    case "Containment":
      return printContainment(node as Containment);
    case "Property":
      return printProperty(node as Property);
    case "TestBlock":
      return printTestBlock(node as TestBlock);
    case "FilterDecl":
      return printFilterDecl(node as import("../generated/ast.js").FilterDecl);
    case "StampDecl":
      return printStampDecl(node as import("../generated/ast.js").StampDecl);
    case "ImplementsDecl":
      return printImplementsDecl(node as import("../generated/ast.js").ImplementsDecl);
    case "Page":
      return printPage(node as Page);
    case "Component":
      return printComponent(node as Component);
    case "Store":
      return printStore(node as import("../generated/ast.js").Store);
    case "Area":
      return printArea(node as import("../generated/ast.js").Area);
    case "StateBlock":
      return printStateBlock(node as StateBlock);
    case "MenuBlock":
      return printMenuBlock(node as MenuBlock);
    case "PermissionsBlock":
      return printPermissionsBlock(node as PermissionsBlock);
    case "UiApiParam":
      return printUiApiParam(node as UiApiParam);
    case "UiChannelParam":
      return printUiChannelParam(node as import("../generated/ast.js").UiChannelParam);
    case "UiNotification":
      return printUiNotification(node as import("../generated/ast.js").UiNotification);
    case "UiFunction":
      return printUiFunction(node as import("../generated/ast.js").UiFunction);
    case "FindDecl":
      return printFindDecl(node as FindDecl);
    case "Criterion":
      return printCriterion(node as import("../generated/ast.js").Criterion);
    case "DomainService":
      return printDomainService(node as import("../generated/ast.js").DomainService);
    case "DomainServiceOperation":
      return printDomainServiceOperation(
        node as import("../generated/ast.js").DomainServiceOperation,
      );
    case "Retrieval":
      return printRetrieval(node as import("../generated/ast.js").Retrieval);
    case "Seed":
      return printSeed(node as import("../generated/ast.js").Seed);
    case "PolicyDecl":
      return printPolicyDecl(node as import("../generated/ast.js").PolicyDecl);
    default:
      throw new Error(`printStructural: unhandled node ${node.$type}`);
  }
}

// ---------------------------------------------------------------------------
// System / deployment shape
// ---------------------------------------------------------------------------

function printSystem(node: System): string {
  return block(`system ${node.name}`, node.members.map(printStructural));
}

function printSubdomain(node: Subdomain): string {
  // `contexts` and `permissions` are interleaved in source but stored in two
  // arrays; AST equality is per-array, so textual order between them is free.
  const items = [
    ...node.permissions.map(printPermissionsBlock),
    ...node.contexts.map(printBoundedContext),
  ];
  return block(`subdomain ${node.name}`, items);
}

function printPermissionsBlock(node: PermissionsBlock): string {
  if (node.decls.length === 0) return "permissions {}";
  return `permissions {\n${indent(node.decls.map((d) => d.name).join(", "))}\n}`;
}

function printThemeBlock(node: ThemeBlock): string {
  return block(
    "theme",
    node.props.map((p) => `${p.name}: ${quote(p.value)}`),
  );
}

function printUserBlock(node: UserBlock): string {
  return block(
    "user",
    node.fields.map((f) => `${f.name}: ${printTypeRef(f.type)}`),
  );
}

function printAuthValue(v: AuthConfigValue): string {
  return v.$type === "EnvAuthValue" ? `env(${quote(v.env)})` : quote(v.value);
}

function printAuthBlock(node: AuthBlock): string {
  const items: string[] = [];
  if (node.provider) items.push(`provider: ${node.provider}`);
  if (node.oidc) {
    const o = node.oidc;
    const oidcItems: string[] = [];
    if (o.issuer) oidcItems.push(`issuer: ${printAuthValue(o.issuer)}`);
    if (o.clientId) oidcItems.push(`clientId: ${printAuthValue(o.clientId)}`);
    if (o.clientSecret) oidcItems.push(`clientSecret: ${printAuthValue(o.clientSecret)}`);
    if (o.audience) oidcItems.push(`audience: ${printAuthValue(o.audience)}`);
    if (o.scopes.length) oidcItems.push(`scopes: [${o.scopes.map(quote).join(", ")}]`);
    items.push(block("oidc", oidcItems));
  }
  if (node.sessions) items.push(`sessions: ${node.sessions}`);
  if (node.claims) {
    // ClaimsMap entries are comma-separated in the grammar (`(',' entry)*`),
    // so join with `,\n` — a bare newline fails to re-parse with 2+ claims.
    const entries = node.claims.entries.map((e) => `${e.field}: ${quote(e.path)}`);
    items.push(
      entries.length === 0 ? "claims: {}" : `claims: {\n${indent(entries.join(",\n"))}\n}`,
    );
  }
  if (node.enforcement) items.push(`enforcement: ${node.enforcement}`);
  return block("auth", items);
}

function printTenancyDecl(node: import("../generated/ast.js").TenancyDecl): string {
  // `tenancy by user.<claim> of <registry>` — the `user.` prefix is fixed
  // surface syntax (multi-tenancy Phase 1a).  Both slots are cross-references
  // (1b.1); print the source text like every other cross-ref printer arm.
  return `tenancy by user.${node.claim.$refText} of ${node.registry.$refText}`;
}

function printLayout(node: Layout): string {
  // Layout slots emit one block per non-main slot + a single bare
  // `main` keyword.  Slot bodies route through printExpr (same as
  // page body printing).
  const items: string[] = [];
  for (const slot of node.slots) {
    if (slot.$type === "LayoutMainSlot") {
      items.push("main");
    } else {
      const named = slot as LayoutNamedSlot;
      items.push(block(named.name, [printExpr(named.body)]));
    }
  }
  return block(`layout ${node.name}`, items);
}

function printStorage(node: Storage): string {
  const items: string[] = [`type: ${node.type}`];
  if (node.instance) items.push(`instance: ${node.instance}`);
  if (node.connection) items.push(`connection: ${printConnectionSource(node.connection)}`);
  const cfg = printConfigItem(node.config);
  if (cfg) items.push(cfg);
  return block(`storage ${node.name}`, items);
}

function printConfigItem(
  config: readonly import("../generated/ast.js").ConfigEntry[],
): string | undefined {
  if (!config.length) return undefined;
  const pairs = config.map((e) => `${e.key}: ${printConfigValue(e.value)}`).join(", ");
  return `config: { ${pairs} }`;
}

function printConfigValue(v: import("../generated/ast.js").ConfigValue): string {
  switch (v.$type) {
    case "StringConfigValue":
      return JSON.stringify(v.value);
    case "IntConfigValue":
      return String(v.value);
    case "BoolConfigValue":
      return v.value;
  }
}

function printDataSource(node: import("../generated/ast.js").Resource): string {
  const items: string[] = [];
  if (node.context) items.push(`for: ${node.context.$refText}`);
  if (node.kind) items.push(`kind: ${node.kind}`);
  if (node.use) items.push(`use: ${node.use.$refText}`);
  if (node.schema) items.push(`schema: ${JSON.stringify(node.schema)}`);
  if (node.tablePrefix) items.push(`tablePrefix: ${JSON.stringify(node.tablePrefix)}`);
  if (node.keyPrefix) items.push(`keyPrefix: ${JSON.stringify(node.keyPrefix)}`);
  if (typeof node.ttl === "number") items.push(`ttl: ${node.ttl}`);
  if (typeof node.every === "number") items.push(`every: ${node.every}`);
  if (typeof node.retain === "number") items.push(`retain: ${node.retain}`);
  if (node.isolationLevel) items.push(`isolationLevel: ${node.isolationLevel}`);
  if (node.readonly) items.push(`readonly: true`);
  if (node.shape) items.push(`shape: ${node.shape}`);
  if (node.indexes.length > 0) {
    // `Entity.col` for a single column, `Entity.(a, b)` for a composite —
    // mirrors the `IndexSpec` grammar (explicit entity qualification).
    const specs = node.indexes.map((s) =>
      s.columns.length === 1
        ? `${s.entity}.${s.columns[0]!}`
        : `${s.entity}.(${s.columns.join(", ")})`,
    );
    items.push(`index: [${specs.join(", ")}]`);
  }
  const cfg = printConfigItem(node.config);
  if (cfg) items.push(cfg);
  return block(`resource ${node.name}`, items);
}

function printConnectionSource(node: import("../generated/ast.js").ConnectionSource): string {
  switch (node.$type) {
    case "ServiceConnectionSource":
      return `service(${node.service})`;
    case "EnvConnectionSource":
      return `env(${JSON.stringify(node.env)})`;
    case "SecretConnectionSource":
      return `secret(${node.secret})`;
    case "LiteralConnectionSource":
      return `literal(${JSON.stringify(node.literal)})`;
  }
}

function printApi(node: Api): string {
  const head = `api ${node.name} from ${node.source.$refText}`;
  const items: string[] = [];
  if (node.urlStyle) items.push(`urlStyle: ${node.urlStyle}`);
  for (const s of node.statuses ?? []) items.push(`httpStatus ${s.error} ${s.code}`);
  // Explicit transport bindings (unfoldable-api-derivation.md, Layer 4):
  //   route POST "/orders" -> Ordering.PlaceOrder
  for (const r of node.routes ?? []) {
    items.push(
      `route ${r.method} ${JSON.stringify(r.path)} -> ${r.target.context.$refText}.${r.target.handler}`,
    );
  }
  return items.length === 0 ? head : block(head, items);
}

function printDeployable(node: Deployable): string {
  // D-REALIZATION-AXES: `platform: <p>` may carry an optional `{ … }` block
  // decomposing the platform bundle into orthogonal axes.  Print the block
  // only when at least one axis is set (bare `platform: dotnet` otherwise).
  const platformLine = `platform: ${enumOrString(node.platform, PLATFORM_KEYWORDS)}`;
  const axes: string[] = [];
  if (node.persistence) axes.push(`persistence: ${node.persistence}`);
  if (node.directoryLayout) axes.push(`directoryLayout: ${node.directoryLayout}`);
  const items: string[] = [axes.length > 0 ? block(platformLine, axes) : platformLine];
  if (node.contextRefs.length > 0) {
    items.push(`contexts: [${node.contextRefs.map((r) => r.$refText).join(", ")}]`);
  }
  if (node.dataSourceRefs.length > 0) {
    items.push(`dataSources: [${node.dataSourceRefs.map((r) => r.$refText).join(", ")}]`);
  }
  if (node.targets) items.push(`targets: ${node.targets.$refText}`);
  if (node.serves.length > 0) {
    items.push(`serves: ${node.serves.map((s) => s.$refText).join(", ")}`);
  }
  if (node.uiSugar) {
    items.push(`ui: ${node.uiSugar.ref.$refText}`);
  } else if (node.uiCompose) {
    const binds = node.uiCompose.bindings.map((b) => `${b.name}: ${b.source.$refText}`);
    items.push(commaBlock(`ui: ${node.uiCompose.ref.$refText}`, binds));
  }
  if (node.port !== undefined) items.push(`port: ${node.port}`);
  if (node.auth) items.push(`auth: ${node.auth}`);
  if (node.design) items.push(`design: ${enumOrString(node.design, DESIGN_KEYWORDS)}`);
  return block(`deployable ${node.name}`, items);
}

function printTestE2E(node: TestE2E): string {
  const verifies = node.verifies ? ` verifies ${node.verifies.$refText}` : "";
  const header = `test e2e ${quote(node.name)} against ${node.deployable.$refText}${verifies}`;
  return block(header, node.body.map(printTestStatement));
}

// ---------------------------------------------------------------------------
// UI / pages
// ---------------------------------------------------------------------------

function printUi(node: Ui): string {
  return block(
    `ui ${node.name}${printWithClause(node.withClause)}`,
    node.members.map(printStructural),
  );
}

/** `area <Name> { …pages / sub-areas… }` — members are Pages and nested
 *  Areas, each printed through the structural printer. */
function printArea(node: import("../generated/ast.js").Area): string {
  return block(`area ${node.name}`, node.members.map(printStructural));
}

function printUiApiParam(node: UiApiParam): string {
  return `api ${node.name}: ${node.apiRef.$refText}`;
}

function printUiChannelParam(node: import("../generated/ast.js").UiChannelParam): string {
  return `channel ${node.name}: ${node.context.$refText}.${node.channel.$refText}`;
}

function printUiFunction(node: import("../generated/ast.js").UiFunction): string {
  const params = node.params.map(printParameter).join(", ");
  return `function ${node.name}(${params}): ${printTypeRef(node.returnType)} extern from ${quote(node.externPath)}`;
}

function printUiNotification(node: import("../generated/ast.js").UiNotification): string {
  return block(
    `on ${node.param.$refText}.${node.event.$refText}(${node.bind})`,
    node.body.map(printStmt),
  );
}

function printPage(node: Page): string {
  const params = node.params.length > 0 ? `(${node.params.map(printParameter).join(", ")})` : "";
  return block(`page ${node.name}${params}`, node.props.map(printPageProp));
}

function printPageProp(node: PageProp): string {
  switch (node.$type) {
    case "RouteProp":
      return `route: ${quote(node.value)}`;
    case "TitleProp":
      return `title: ${printExpr(node.value)}`;
    case "RequiresProp":
      return `requires ${printExpr(node.expr)}`;
    case "BodyProp":
      return `body: ${printExpr(node.expr)}`;
    case "StateBlock":
      return printStateBlock(node);
    case "PageMenuMeta":
      return commaBlock(
        "menu",
        node.entries.map((e) => `${e.name}: ${printExpr(e.value)}`),
      );
    case "LayoutProp":
      return `layout: ${node.value}`;
    case "DescriptionProp":
      return `description: ${quote(node.value)}`;
    case "OgImageProp":
      return `ogImage: ${quote(node.value)}`;
    case "CanonicalProp":
      return `canonical: ${quote(node.value)}`;
    case "DerivedProp":
      return printDerivedProp(node);
    case "ActionDecl":
      return printActionDecl(node);
    default: {
      const exhaustive: never = node;
      throw new Error(`printPageProp: unhandled ${(exhaustive as { $type: string }).$type}`);
    }
  }
}

function printComponentDecl(node: ComponentDecl): string {
  switch (node.$type) {
    case "DerivedProp":
      return printDerivedProp(node);
    case "ActionDecl":
      return printActionDecl(node);
    default:
      return printStateBlock(node);
  }
}

function printComponent(node: Component): string {
  const params = node.params.map(printParameter).join(", ");
  // An extern component declares no body — its rendering lives in a
  // hand-written module at the `from` path.
  if (node.extern) {
    const header = `component ${node.name}(${params}) extern from ${quote(node.externPath ?? "")}`;
    return block(header, node.decls.map(printComponentDecl));
  }
  const items = [
    ...node.decls.map(printComponentDecl),
    `body: ${node.body ? printExpr(node.body) : ""}`,
  ];
  return block(`component ${node.name}(${params})`, items);
}

/** `store Name { state {…} action …(…) {…} }` — a shared client-side state
 *  container (named-actions-and-stores.md §3).  Its decls reuse the StateBlock
 *  / ActionDecl printers verbatim (same surface as a page/component body).
 *  The optional `persist: <lifetime>` clause (frontend-state-management.md
 *  §3.1) round-trips as a header modifier. */
function printStore(node: import("../generated/ast.js").Store): string {
  const persist = node.lifetime ? ` persist: ${node.lifetime}` : "";
  return block(
    `store ${node.name}${persist}`,
    node.decls.map((d) => (d.$type === "ActionDecl" ? printActionDecl(d) : printStateBlock(d))),
  );
}

function printStateBlock(node: StateBlock): string {
  return block(
    "state",
    node.fields.map((f) => {
      const init = f.init ? ` = ${printExpr(f.init)}` : "";
      return `${f.name}: ${printTypeRef(f.type)}${init}`;
    }),
  );
}

function printMenuBlock(node: MenuBlock): string {
  return block("menu", node.sections.map(printMenuSection));
}

function printMenuSection(node: MenuSection): string {
  if (node.links.length === 0) return `section ${quote(node.label)} {}`;
  return `section ${quote(node.label)} {\n${indent(node.links.map(printMenuLink).join(",\n"))}\n}`;
}

function printMenuLink(node: MenuLink): string {
  if (node.externalUrl) {
    return `link ${quote(node.externalLabel!)} -> ${quote(node.externalUrl)}`;
  }
  const head = `link ${node.page!.$refText}`;
  if (node.props.length === 0) return head;
  const props = node.props.map((p) => `${p.name}: ${printExpr(p.value)}`).join(", ");
  return `${head} { ${props} }`;
}

// ---------------------------------------------------------------------------
// Bounded context + domain members
// ---------------------------------------------------------------------------

function printBoundedContext(node: BoundedContext): string {
  return block(
    `context ${node.name}${printWithClause(node.withClause)}`,
    node.members.map((m) => printContextMember(m)),
  );
}

/** `capability <name> { <field|filter|stamp>… }` (typed-capabilities.md) —
 * a pure-mixin bundle.  Every body member (`Property`/`FilterDecl`/
 * `StampDecl`) is itself printable, so it reuses `printStructural`. */
function printCapability(node: import("../generated/ast.js").Capability): string {
  return block(
    `capability ${node.name}`,
    node.members.map((m) => printStructural(m)),
  );
}

/** `filter <expr>` — applies to its aggregate, or every aggregate at context scope. */
function printFilterDecl(node: import("../generated/ast.js").FilterDecl): string {
  return `filter ${printExpr(node.expr)}`;
}

/** `stamp <event> { ... }` */
function printStampDecl(node: import("../generated/ast.js").StampDecl): string {
  return block(
    `stamp ${node.event}`,
    (node.assignments ?? []).map((a) => printStmt(a as never)),
  );
}

/** `implements <Cap>` (typed capability application) */
function printImplementsDecl(node: import("../generated/ast.js").ImplementsDecl): string {
  return `implements ${node.cap}`;
}

/** `seed [dataset] [raw] { <Agg> { … } … }` (database-seeding.md) */
function printSeed(node: import("../generated/ast.js").Seed): string {
  const dataset = node.dataset ? ` ${node.dataset}` : "";
  const raw = node.raw ? " raw" : "";
  return block(
    `seed${dataset}${raw}`,
    node.rows.map((r) => `${r.aggregate.$refText} ${printExpr(r.value)}`),
  );
}

/** `policy <Name>? { allow <level> on <Aggregate> … }` (authorization.md §3;
 *  multi-tenancy Phase 2 P2.4 — the read-reachability ladder) OR the function
 *  form `policy <Name>(<params>): bool = <expr>` (authorization Phase 3.2 — a
 *  named, requires-gated authorization predicate). */
function printPolicyDecl(node: import("../generated/ast.js").PolicyDecl): string {
  // Function form: carries a `returnType` (the read-ladder block has none).
  if (node.returnType) {
    const params = node.params.map(printParameter).join(", ");
    return `policy ${node.name}(${params}): ${printTypeRef(node.returnType)} = ${node.body ? printExpr(node.body) : ""}`;
  }
  const name = node.name ? ` ${node.name}` : "";
  return block(
    `policy${name}`,
    (node.rules ?? []).map((r) =>
      r.effect === "deny"
        ? `deny ${r.verb ? `${r.verb} ` : ""}on ${r.target}`
        : `allow ${r.verb ? `${r.verb} ` : ""}${r.level} on ${r.target}`,
    ),
  );
}

function printContextMember(node: ContextMember): string {
  return printStructural(node);
}

function printEnumDecl(node: EnumDecl): string {
  return commaBlock(
    `enum ${node.name}`,
    node.values.map((v) => v.name),
  );
}

function printValueObject(node: ValueObject): string {
  return block(`valueobject ${node.name}`, node.members.map(printStructural));
}

function printAggregate(node: Aggregate): string {
  // Header modifiers in grammar order (ddd.langium `Aggregate`):
  //   [abstract] aggregate <name> [extends <Base>] [crossTenant]
  //   [persistedAs(…)] [shape(…)] [inheritanceUsing(…)] [with …]
  const abstract = node.isAbstract ? "abstract " : "";
  const ext = node.superType ? ` extends ${node.superType.$refText}` : "";
  // `crossTenant` (multi-tenancy Phase 1a) is the first header flag, before the
  // paren modifiers — matches the grammar order.
  const crossTenant = node.crossTenant ? " crossTenant" : "";
  // `persistedAs(…)` is a header modifier (between `ids` and `with`),
  // not a body member — matches the grammar order.
  const persistedAs = node.persistedAs ? ` persistedAs(${node.persistedAs})` : "";
  const shape = node.shape ? ` shape(${node.shape})` : "";
  const inheritanceUsing = node.inheritanceUsing
    ? ` inheritanceUsing(${node.inheritanceUsing})`
    : "";
  return block(
    `${abstract}aggregate ${node.name}${ext}${crossTenant}${persistedAs}${shape}${inheritanceUsing}${printWithClause(node.withClause)}`,
    node.members.map(printStructural),
  );
}

function printWithClause(wc: import("../generated/ast.js").WithClause | undefined): string {
  if (!wc || (wc.calls ?? []).length === 0) return "";
  const parts = (wc.calls ?? []).map((c) => printMacroCall(c));
  return ` with ${parts.join(", ")}`;
}

function printMacroCall(c: import("../generated/ast.js").MacroCall): string {
  const args = (c.args ?? []).map(printMacroArg);
  if (args.length === 0 && c.$cstNode?.text?.endsWith("()")) {
    return `${c.name}()`;
  }
  return args.length === 0 ? c.name : `${c.name}(${args.join(", ")})`;
}

function printMacroArg(a: import("../generated/ast.js").MacroArg): string {
  return `${a.name}: ${printMacroArgValue(a.value)}`;
}

function printMacroArgValue(v: import("../generated/ast.js").MacroArgValue): string {
  switch (v.$type) {
    case "MacroArgString":
      return quote(readArgString(v) ?? "");
    case "MacroArgBool":
      return readArgBoolLiteral(v) ?? "false";
    case "MacroArgInt":
      return String(readArgInt(v) ?? 0);
    case "MacroArgRef":
      return readArgRef(v) ?? "";
    case "MacroArgRefList":
      return `[${readArgRefs(v).join(", ")}]`;
  }
}

function printEntityPart(node: EntityPart): string {
  return block(`entity ${node.name}`, node.members.map(printStructural));
}

function printEventDecl(node: EventDecl): string {
  return commaBlock(`event ${node.name}`, node.fields.map(printProperty));
}

/** Payload family (`command`/`query`/`response`/`error` <Name> { … }) —
 *  same record shape as an event; the `kind` keyword carries the intent. */
function printPayloadDecl(node: import("../generated/ast.js").PayloadDecl): string {
  // Named union (P4): `payload Foo = A | B | C`.  Variant atoms only — the
  // record form falls through to the brace block below.
  if (node.variants.length > 0) {
    return `${node.kind} ${node.name} = ${node.variants.map(printTypeAtom).join(" | ")}`;
  }
  return commaBlock(`${node.kind} ${node.name}`, node.fields.map(printProperty));
}

/** `channel <Name> { carries: … delivery: … retention: … key: … }`
 *  (channels.md, Slice 1). */
function printChannel(node: import("../generated/ast.js").Channel): string {
  const items: string[] = [`carries: ${node.carries.map((c) => c.$refText).join(", ")}`];
  if (node.delivery) items.push(`delivery: ${node.delivery}`);
  if (node.retention) items.push(`retention: ${node.retention}`);
  if (node.key) items.push(`key: ${node.key}`);
  return block(`channel ${node.name}`, items);
}

/** `channelSource <Name> { for: <channel> use: <storage> }` — binds a
 *  channel contract to a physical transport storage. */
function printChannelSource(node: import("../generated/ast.js").ChannelSource): string {
  const items: string[] = [`for: ${node.channel}`];
  if (node.use) items.push(`use: ${node.use.$refText}`);
  return block(`channelSource ${node.name}`, items);
}

function printRepository(node: Repository): string {
  return block(
    `repository ${node.name} for ${node.aggregate.$refText}`,
    node.finds.map(printFindDecl),
  );
}

/** ` ignoring *` / ` ignoring A, B` — the trailing filter-bypass clause shared
 *  by find / view / inline-read printing (named-filter-bypass.md §11).  Returns
 *  "" when the read bypasses nothing, so it spreads cleanly onto the tail. */
export function printIgnoringClause(node: { bypassAll?: boolean; bypass?: string[] }): string {
  if (node.bypassAll) return " ignoring *";
  return node.bypass && node.bypass.length > 0 ? ` ignoring ${node.bypass.join(", ")}` : "";
}

function printFindDecl(node: FindDecl): string {
  const params = node.params.map(printParameter).join(", ");
  const where = node.filter ? ` where ${printExpr(node.filter)}` : "";
  return `find ${node.name}(${params}): ${printTypeRef(node.returnType)}${where}${printIgnoringClause(node)}`;
}

/** `criterion <Name>[(<params>)] of <T> = <expr>` — the single-line form
 *  round-trips both source variants (the `{ where: … }` block lowers to
 *  the same `body`). */
function printCriterion(node: import("../generated/ast.js").Criterion): string {
  const params = node.params.length > 0 ? `(${node.params.map(printParameter).join(", ")})` : "";
  return `criterion ${node.name}${params} of ${printTypeRef(node.target)} = ${printExpr(node.body)}`;
}

/** `domainService <Name> { operation … }` — a stateless container of
 *  non-mutating operations (domain-services.md). */
function printDomainService(node: import("../generated/ast.js").DomainService): string {
  return block(`domainService ${node.name}`, node.operations.map(printDomainServiceOperation));
}

/** One `operation <name>(<params>)[: <ret>] { <stmts> }` of a domain
 *  service — statement-body only in v1 (no `=`-shorthand), no
 *  private/extern/audited/when modifiers. */
function printDomainServiceOperation(
  node: import("../generated/ast.js").DomainServiceOperation,
): string {
  const params = node.params.map(printParameter).join(", ");
  const ret = node.returnType ? `: ${printTypeRef(node.returnType)}` : "";
  return block(`operation ${node.name}(${params})${ret}`, node.stmts.map(printStmt));
}

/** `retrieval <Name>[(<params>)] of <T>` — single-line `= <where>` when no
 *  `sort`/`loads`, otherwise the `{ where: … sort: … loads: … }` block. */
function printRetrieval(node: import("../generated/ast.js").Retrieval): string {
  const params = node.params.length > 0 ? `(${node.params.map(printParameter).join(", ")})` : "";
  const head = `retrieval ${node.name}${params} of ${printTypeRef(node.target)}`;
  if (node.sort.length === 0 && node.loads.length === 0) {
    return `${head} = ${printExpr(node.where)}`;
  }
  const items: string[] = [`where: ${printExpr(node.where)}`];
  if (node.sort.length > 0) {
    items.push(`sort: [${node.sort.map(printSortItem).join(", ")}]`);
  }
  if (node.loads.length > 0) {
    items.push(`loads: [${node.loads.map(printLoadPath).join(", ")}]`);
  }
  return block(head, items);
}

function printSortItem(node: import("../generated/ast.js").SortItem): string {
  const dir = node.direction ? ` ${node.direction}` : "";
  return `${printLoadPath(node.path)}${dir}`;
}

function printLoadPath(node: import("../generated/ast.js").LoadPath): string {
  return node.segments.map((s) => `${s.name}${s.collection ? "[]" : ""}`).join(".");
}

function printWorkflow(node: Workflow): string {
  // A2-S5f: members-only body, no header params.
  const es = node.eventSourced ? " eventSourced" : "";
  let head = `workflow ${node.name}${es}`;
  if (node.transactional) {
    head += node.isolation ? ` transactional(${node.isolation})` : " transactional";
  }
  return block(
    head,
    node.members.map((m) =>
      m.$type === "WorkflowCreateDecl"
        ? printWorkflowCreateDecl(m)
        : m.$type === "OnDecl"
          ? printOnDecl(m)
          : m.$type === "Property"
            ? printProperty(m)
            : m.$type === "Apply"
              ? printApply(m)
              : m.$type === "FunctionDecl"
                ? printFunctionDecl(m)
                : printHandleDecl(m),
    ),
  );
}

// `create [name](params) [by <expr>] { … }` workflow starter (workflow-and-applier.md A2-S5f).
function printWorkflowCreateDecl(node: import("../generated/ast.js").WorkflowCreateDecl): string {
  const name = node.name ? ` ${node.name}` : "";
  const params = node.params.map(printParameter).join(", ");
  const by = node.correlation ? ` by ${printExpr(node.correlation)}` : "";
  return block(`create${name}(${params})${by}`, node.body.map(printStmt));
}

// `handle name(params) { … }` command-handler member (workflow-and-applier.md A2).
function printHandleDecl(node: import("../generated/ast.js").HandleDecl): string {
  const params = node.params.map(printParameter).join(", ");
  return block(`handle ${node.name}(${params})`, node.body.map(printStmt));
}

// `on(e: Event) [by <expr>] { … }` reactor member (workflow-and-applier.md A2).
function printOnDecl(node: OnDecl): string {
  const by = node.correlation ? ` by ${printExpr(node.correlation)}` : "";
  const head = `on(${node.param}: ${node.event.$refText})${by}`;
  return block(head, node.body.map(printStmt));
}

// `projection <Name> keyed by <field> { … }` read model (projection.md).
function printProjection(node: import("../generated/ast.js").Projection): string {
  return block(
    `projection ${node.name} keyed by ${node.key}`,
    node.members.map((m) => (m.$type === "ProjectionOn" ? printProjectionOn(m) : printProperty(m))),
  );
}

// `on(e: Event) [by <expr>] { … }` pure fold member of a projection.
function printProjectionOn(node: import("../generated/ast.js").ProjectionOn): string {
  const by = node.correlation ? ` by ${printExpr(node.correlation)}` : "";
  const head = `on(${node.param}: ${node.event.$refText})${by}`;
  return block(head, node.body.map(printStmt));
}

function printView(node: View): string {
  // Optional `requires <expr>` authorization gate (D-AUTH-OIDC / default-deny),
  // printed between the source and the `where` filter in both forms.
  const gate = node.gate ? ` requires ${printExpr(node.gate)}` : "";
  // Full form is the only one that carries `bind` entries (grammar requires
  // ≥1), so a populated `binds` discriminates it from the shorthand.
  const ignoring = printIgnoringClause(node);
  if (node.binds.length > 0) {
    const items: string[] = node.fields.map(printProperty);
    items.push(`from ${node.source.$refText}`);
    if (node.gate) items.push(`requires ${printExpr(node.gate)}`);
    if (node.filter) items.push(`where ${printExpr(node.filter)}`);
    // The `ignoring` clause prints on its own line in the block form (it sits
    // between `where` and `bind` in the grammar); `.trimStart()` drops the
    // leading space `printIgnoringClause` adds for the inline form.
    if (ignoring) items.push(ignoring.trimStart());
    items.push(`bind ${node.binds.map(printBindEntry).join(", ")}`);
    return block(`view ${node.name}`, items);
  }
  return `view ${node.name} = ${node.source.$refText}${gate} where ${printExpr(node.filter!)}${ignoring}`;
}

function printBindEntry(node: BindEntry): string {
  return `${node.name} = ${printExpr(node.expr)}`;
}

function printProperty(node: Property): string {
  const provenanced = node.provenanced ? " provenanced" : "";
  const sensitivity =
    node.sensitivity && node.sensitivity.tags.length > 0
      ? ` sensitive(${node.sensitivity.tags.join(", ")})`
      : "";
  const access = node.access ? ` ${node.access}` : "";
  // `= <expr>` default clause — grammar places it after the access modifier
  // and before `check` (ddd.langium Property rule), so the expression can't
  // greedily swallow a trailing modifier keyword.
  const def = node.default ? ` = ${printExpr(node.default)}` : "";
  const check = node.check ? ` check ${printExpr(node.check)}` : "";
  return `${node.name}: ${printTypeRef(node.type)}${provenanced}${sensitivity}${access}${def}${check}`;
}

function printContainment(node: Containment): string {
  return `contains ${node.name}: ${node.partType.$refText}${node.collection ? "[]" : ""}${node.optional ? "?" : ""}`;
}

function printDerivedProp(node: DerivedProp): string {
  return `derived ${node.name}: ${printTypeRef(node.type)} = ${printExpr(node.expr)}`;
}

/** `action <name>(<params>) { <stmts> }` — the named page/component event
 *  handler (named-actions-and-stores.md, Proposal A Stage 1).  Body prints
 *  through the shared statement printer, exactly like an operation body. */
function printActionDecl(node: ActionDecl): string {
  const params = node.params.map(printParameter).join(", ");
  return block(`action ${node.name}(${params})`, node.stmts.map(printStmt));
}

function printInvariant(node: Invariant): string {
  const priv = node.serverOnly ? "private " : "";
  const guard = node.guard ? ` when ${printExpr(node.guard)}` : "";
  return `${priv}invariant ${printExpr(node.expr)}${guard}`;
}

function printUnique(node: import("../generated/ast.js").Unique): string {
  return `unique (${node.columns.join(", ")})`;
}

function printFunctionDecl(node: FunctionDecl): string {
  const params = node.params.map(printParameter).join(", ");
  const head = `function ${node.name}(${params}): ${printTypeRef(node.returnType)}`;
  // Block form (domain-services.md rev. 4) prints as `head { stmts }`; the
  // expression form keeps the `= expr` single-line shape.
  if (node.body === undefined) {
    return block(head, node.block.map(printStmt));
  }
  return `${head} = ${printExpr(node.body)}`;
}

function printOperation(node: Operation): string {
  const priv = node.private ? "private " : "";
  const params = node.params.map(printParameter).join(", ");
  const extern = node.extern ? " extern" : "";
  const audited = node.audited ? " audited" : "";
  // Exception-less `or`-union return (exception-less.md): `: X or NotFound`,
  // grammar-positioned after extern/audited.
  const ret = node.returnType ? `: ${printTypeRef(node.returnType)}` : "";
  // canCommand state gate (criterion.md use site 2) — after the return type,
  // before the body, matching the grammar.
  const when = node.when ? ` when ${printExpr(node.when)}` : "";
  return block(
    `${priv}operation ${node.name}(${params})${extern}${audited}${ret}${when}`,
    node.body.map(printStmt),
  );
}

// `commandHandler name(params)[: T] { … }` application-layer context member
// (unfoldable-api-derivation.md, Layer 3).  Return type is optional.
function printCommandHandler(node: import("../generated/ast.js").CommandHandler): string {
  const params = node.params.map(printParameter).join(", ");
  const ret = node.returnType ? `: ${printTypeRef(node.returnType)}` : "";
  return block(`commandHandler ${node.name}(${params})${ret}`, node.body.map(printStmt));
}

// `queryHandler name(params): T { … }` application-layer context member
// (unfoldable-api-derivation.md, Layer 3).  Return type is required.
function printQueryHandler(node: import("../generated/ast.js").QueryHandler): string {
  const params = node.params.map(printParameter).join(", ");
  return block(
    `queryHandler ${node.name}(${params}): ${printTypeRef(node.returnType)}`,
    node.body.map(printStmt),
  );
}

function printCreate(node: import("../generated/ast.js").Create): string {
  // Lifecycle factory.  Unnamed (`create(...)`) is the canonical creator;
  // a name is optional.  Parens are always present in the grammar.
  const name = node.name ? ` ${node.name}` : "";
  const params = node.params.map(printParameter).join(", ");
  const audited = node.audited ? " audited" : "";
  return block(`create${name}(${params})${audited}`, node.body.map(printStmt));
}

function printDestroy(node: import("../generated/ast.js").Destroy): string {
  // Lifecycle terminator.  Both the name and the parameter list are
  // optional — the canonical hard delete reads `destroy { }`.
  const name = node.name ? ` ${node.name}` : "";
  const params = node.params.map(printParameter).join(", ");
  const paramClause = node.params.length > 0 || node.name ? `(${params})` : "";
  const audited = node.audited ? " audited" : "";
  return block(`destroy${name}${paramClause}${audited}`, node.body.map(printStmt));
}

function printApply(node: import("../generated/ast.js").Apply): string {
  // `$refText` (not `.ref`) — the printer must work on detached / not-yet-linked
  // nodes (the round-trip harness re-parses without a workspace), and the source
  // reference text is exactly what we re-emit.
  return block(`apply(${node.param}: ${node.event.$refText})`, node.body.map(printStmt));
}

function printTestBlock(node: TestBlock): string {
  const verifies = node.verifies ? ` verifies ${node.verifies.$refText}` : "";
  return block(`test ${quote(node.name)}${verifies}`, node.body.map(printTestStatement));
}

/** TestStatement adds `expect` (with a method matcher) over the ordinary
 *  Statement set. */
function printTestStatement(node: TestStatement): string {
  if (node.$type === "ExpectStmt") return `expect ${printExpr(node.expr)}`;
  return printStmt(node as Statement);
}

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

function printRequirement(node: Requirement): string {
  const parent = node.parent ? ` parent ${node.parent.$refText}` : "";
  return block(
    `requirement ${node.name}${parent}`,
    node.props.map((p) => `${p.name}: ${printExpr(p.value)}`),
  );
}

function printSolution(node: Solution): string {
  const items: string[] = [];
  if (node.title !== undefined) items.push(`title: ${quote(node.title)}`);
  if (node.entitles.length > 0) {
    items.push(`entitles [${node.entitles.map((e) => e.$refText).join(", ")}]`);
  }
  return block(`solution ${node.name} for ${node.requirement.$refText}`, items);
}

function printTestCase(node: TestCase): string {
  const items: string[] = [];
  if (node.title !== undefined) items.push(`title: ${quote(node.title)}`);
  if (node.covers.length > 0) {
    items.push(`covers [${node.covers.map((c) => c.$refText).join(", ")}]`);
  }
  return block(`testCase ${node.name} verifies ${node.requirement.$refText}`, items);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function printParameter(node: Parameter): string {
  return `${node.name}: ${printTypeRef(node.type)}`;
}

function printTypeRef(node: TypeRef): string {
  // The head atom plus any anonymous `or`-union alternatives (P4).  A
  // non-union TypeRef has an empty `alternatives` and prints as a bare atom.
  const head = printTypeAtom(node);
  const alts = node.alternatives ?? [];
  if (alts.length === 0) return head;
  return [head, ...alts.map(printTypeAtom)].join(" or ");
}

/** Print one type atom — `base` plus the postfix generic carriers (P3:
 *  `customer paged`; P4: `T option`) and the array/optional suffixes, matching
 *  the grammar's `base (ctors)* ([]) (?)` order.  Shared by `printTypeRef`'s
 *  head + `or`-alternatives and by named-union variant printing. */
function printTypeAtom(node: TypeRef | import("../generated/ast.js").TypeAtom): string {
  const base = node.base;
  let s: string;
  switch (base.$type) {
    case "PrimitiveType":
      s = base.name;
      break;
    case "SlotType":
      s = "slot";
      break;
    case "ActionType":
      s = base.arg ? `action(${printTypeRef(base.arg)})` : "action";
      break;
    case "SelfType":
      s = "Self id";
      break;
    case "IdType":
      s = `${base.target.$refText} id`;
      break;
    case "NamedType":
      s = base.target.$refText;
      break;
    default: {
      const exhaustive: never = base;
      throw new Error(`printTypeAtom: unhandled base ${(exhaustive as { $type: string }).$type}`);
    }
  }
  // Guard against programmatically built nodes (web builder, macros) that may
  // omit the ctor list.
  const ctorList = node.ctors ?? [];
  const ctors = ctorList.length > 0 ? ` ${ctorList.join(" ")}` : "";
  return `${s}${ctors}${node.array ? "[]" : ""}${node.optional ? "?" : ""}`;
}
