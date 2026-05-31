import type { AstNode } from "langium";
import {
  readArgBoolLiteral,
  readArgInt,
  readArgRef,
  readArgRefs,
  readArgString,
} from "../../macros/api/_read.js";
import type {
  Aggregate,
  Api,
  BindEntry,
  BoundedContext,
  Component,
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
  LayoutMainSlot,
  LayoutNamedSlot,
  MenuBlock,
  MenuLink,
  MenuSection,
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
  UiHelperImport,
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

const PLATFORM_KEYWORDS = new Set(["dotnet", "hono", "react", "static", "phoenixLiveView"]);
const DESIGN_KEYWORDS = new Set(["mantine", "shadcn", "mui", "chakra", "ashPhoenix"]);

/** Platform / DesignPack are `keyword | STRING` rules: print a known keyword
 *  bare, otherwise re-quote (the value came from the STRING alternative). */
function enumOrString(value: string, keywords: Set<string>): string {
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
    case "Repository":
      return printRepository(node as Repository);
    case "Workflow":
      return printWorkflow(node as Workflow);
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
    case "Apply":
      return printApply(node as import("../generated/ast.js").Apply);
    case "FunctionDecl":
      return printFunctionDecl(node as FunctionDecl);
    case "DerivedProp":
      return printDerivedProp(node as DerivedProp);
    case "Invariant":
      return printInvariant(node as Invariant);
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
    case "StateBlock":
      return printStateBlock(node as StateBlock);
    case "MenuBlock":
      return printMenuBlock(node as MenuBlock);
    case "PermissionsBlock":
      return printPermissionsBlock(node as PermissionsBlock);
    case "UiApiParam":
      return printUiApiParam(node as UiApiParam);
    case "UiHelperImport":
      return printUiHelperImport(node as UiHelperImport);
    case "FindDecl":
      return printFindDecl(node as FindDecl);
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
  return `api ${node.name} from ${node.source.$refText}`;
}

function printDeployable(node: Deployable): string {
  const items: string[] = [`platform: ${enumOrString(node.platform, PLATFORM_KEYWORDS)}`];
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
  } else if (node.uiBlock) {
    const inner = node.uiBlock.framework ? [`framework: ${node.uiBlock.framework}`] : [];
    items.push(block(`ui ${node.uiBlock.ref.$refText}`, inner));
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

function printUiApiParam(node: UiApiParam): string {
  return `api ${node.name}: ${node.apiRef.$refText}`;
}

function printUiHelperImport(node: UiHelperImport): string {
  return `import helper ${node.name} from ${quote(node.path)}`;
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
    default: {
      const exhaustive: never = node;
      throw new Error(`printPageProp: unhandled ${(exhaustive as { $type: string }).$type}`);
    }
  }
}

function printComponent(node: Component): string {
  const params = node.params.map(printParameter).join(", ");
  const items = [...node.decls.map(printStateBlock), `body: ${printExpr(node.body)}`];
  return block(`component ${node.name}(${params})`, items);
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

/** `filter [for "<name>"] <expr>` — capability-scoped variant when
 * `for` is set, otherwise applies to every aggregate at scope. */
function printFilterDecl(node: import("../generated/ast.js").FilterDecl): string {
  const cap = (node as { capability?: string }).capability;
  const forClause = cap ? ` for ${quote(cap)}` : "";
  return `filter${forClause} ${printExpr(node.expr)}`;
}

/** `stamp [for "<name>"] <event> { ... }` */
function printStampDecl(node: import("../generated/ast.js").StampDecl): string {
  const cap = (node as { capability?: string }).capability;
  const forClause = cap ? ` for ${quote(cap)}` : "";
  return block(
    `stamp${forClause} ${node.event}`,
    (node.assignments ?? []).map((a) => printStmt(a as never)),
  );
}

/** `implements "<name>"` */
function printImplementsDecl(node: import("../generated/ast.js").ImplementsDecl): string {
  return `implements ${quote(node.name)}`;
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
  const ids = node.idKind ? ` ids ${node.idKind}` : "";
  // `persistedAs(…)` is a header modifier (between `ids` and `with`),
  // not a body member — matches the grammar order.
  const persistedAs = node.persistedAs ? ` persistedAs(${node.persistedAs})` : "";
  const shape = node.shape ? ` shape(${node.shape})` : "";
  return block(
    `aggregate ${node.name}${ids}${persistedAs}${shape}${printWithClause(node.withClause)}`,
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

function printRepository(node: Repository): string {
  return block(
    `repository ${node.name} for ${node.aggregate.$refText}`,
    node.finds.map(printFindDecl),
  );
}

function printFindDecl(node: FindDecl): string {
  const params = node.params.map(printParameter).join(", ");
  const where = node.filter ? ` where ${printExpr(node.filter)}` : "";
  return `find ${node.name}(${params}): ${printTypeRef(node.returnType)}${where}`;
}

function printWorkflow(node: Workflow): string {
  const params = node.params.map(printParameter).join(", ");
  let head = `workflow ${node.name}(${params})`;
  if (node.transactional) {
    head += node.isolation ? ` transactional(${node.isolation})` : " transactional";
  }
  return block(head, node.body.map(printStmt));
}

function printView(node: View): string {
  // Full form is the only one that carries `bind` entries (grammar requires
  // ≥1), so a populated `binds` discriminates it from the shorthand.
  if (node.binds.length > 0) {
    const items: string[] = node.fields.map(printProperty);
    items.push(`from ${node.source.$refText}`);
    if (node.filter) items.push(`where ${printExpr(node.filter)}`);
    items.push(`bind ${node.binds.map(printBindEntry).join(", ")}`);
    return block(`view ${node.name}`, items);
  }
  return `view ${node.name} = ${node.source.$refText} where ${printExpr(node.filter!)}`;
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
  const check = node.check ? ` check ${printExpr(node.check)}` : "";
  return `${node.name}: ${printTypeRef(node.type)}${provenanced}${sensitivity}${access}${check}`;
}

function printContainment(node: Containment): string {
  return `contains ${node.name}: ${node.partType.$refText}${node.collection ? "[]" : ""}${node.optional ? "?" : ""}`;
}

function printDerivedProp(node: DerivedProp): string {
  return `derived ${node.name}: ${printTypeRef(node.type)} = ${printExpr(node.expr)}`;
}

function printInvariant(node: Invariant): string {
  const priv = node.serverOnly ? "private " : "";
  const guard = node.guard ? ` when ${printExpr(node.guard)}` : "";
  return `${priv}invariant ${printExpr(node.expr)}${guard}`;
}

function printFunctionDecl(node: FunctionDecl): string {
  const params = node.params.map(printParameter).join(", ");
  return `function ${node.name}(${params}): ${printTypeRef(node.returnType)} = ${printExpr(node.body)}`;
}

function printOperation(node: Operation): string {
  const priv = node.private ? "private " : "";
  const params = node.params.map(printParameter).join(", ");
  const extern = node.extern ? " extern" : "";
  const audited = node.audited ? " audited" : "";
  return block(
    `${priv}operation ${node.name}(${params})${extern}${audited}`,
    node.body.map(printStmt),
  );
}

function printApply(node: import("../generated/ast.js").Apply): string {
  const event = node.event.ref?.name ?? node.event.$refText;
  return block(`apply(${node.param}: ${event})`, node.body.map(printStmt));
}

function printTestBlock(node: TestBlock): string {
  const verifies = node.verifies ? ` verifies ${node.verifies.$refText}` : "";
  return block(`test ${quote(node.name)}${verifies}`, node.body.map(printTestStatement));
}

/** TestStatement adds `expect` / `expectThrows` over the ordinary Statement set. */
function printTestStatement(node: TestStatement): string {
  if (node.$type === "ExpectStmt") return `expect ${printExpr(node.expr)}`;
  if (node.$type === "ExpectThrowsStmt") return `expectThrows ${printExpr(node.expr)}`;
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
  const base = node.base;
  let s: string;
  switch (base.$type) {
    case "PrimitiveType":
      s = base.name;
      break;
    case "SlotType":
      s = "slot";
      break;
    case "IdType":
      s = `${base.target.$refText} id`;
      break;
    case "NamedType":
      s = base.target.$refText;
      break;
    default: {
      const exhaustive: never = base;
      throw new Error(`printTypeRef: unhandled base ${(exhaustive as { $type: string }).$type}`);
    }
  }
  return `${s}${node.array ? "[]" : ""}${node.optional ? "?" : ""}`;
}
