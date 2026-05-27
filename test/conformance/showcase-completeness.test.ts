import * as path from "node:path";
import { AstUtils, type LangiumDocument, URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { STDLIB_LAYOUT_COMPONENTS } from "../../src/generator/react/body-walker.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import { type Model, reflection } from "../../src/language/generated/ast.js";
import { repoRoot } from "../_helpers/examples.js";
import { extractErrors } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Conformance completeness guard for `examples/showcase.ddd`.
//
// `showcase.ddd` is the dedicated fixture meant to exercise EVERY language
// feature so the cross-generator harness has one system that touches the
// whole surface.  This guard measures coverage against two real registries:
//
//   1. Every concrete AST node kind  — `reflection.getAllTypes()` minus the
//      abstract union supertypes (which are never emitted as a `$type`).
//   2. Every React walker UI primitive — `STDLIB_LAYOUT_COMPONENTS`.
//
// PHASE 1 = REPORT-ONLY.  The guard logs what's still uncovered but does NOT
// fail the build — the showcase is built out iteratively.  Flip `HARD_GATE`
// to `true` once coverage is complete to make missing coverage a hard error
// (the assertions are already written below, just gated).
// ---------------------------------------------------------------------------

const HARD_GATE = false;

const SHOWCASE = "examples/showcase.ddd";

/**
 * Abstract union supertypes in the grammar — declared as `X: A | B | ...`,
 * never instantiated, so they never appear as a concrete `node.$type`.
 * They must be excluded from the "every kind appears" check or it can never
 * pass.  Derived from `src/language/ddd.langium` union rules.
 */
const UNION_SUPERTYPES = new Set<string>([
  "AggregateMember",
  "BaseType",
  "ComponentDecl",
  "ContextMember",
  "EntityPartMember",
  "Expression",
  "LiteralExpr",
  "LValue",
  "ModelMember",
  "NamedDecl",
  "NamedType",
  "PageProp",
  "Statement",
  "SystemMember",
  "Targetable",
  "TestStatement",
  "UiMember",
  "ValueObjectMember",
]);

/**
 * Concrete AST kinds intentionally excluded from the coverage requirement —
 * legacy/deprecated forms or kinds mutually exclusive with one already
 * present.  Each entry needs a justifying comment.  Seeded empty; populated
 * as the first guard runs reveal genuinely uncoverable kinds.
 */
const ALLOWLIST = new Set<string>([
  // "UiBlockBinding", // legacy ui-block binding, superseded by UiComposeBinding — confirm before enabling
]);

async function buildShowcase(): Promise<LangiumDocument<Model>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, SHOWCASE)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc as LangiumDocument<Model>;
}

/** Names of every primitive/component invoked anywhere in the model — the
 *  callee identifier of a call expression (the walker dispatches on these).
 *  Collected loosely at AST level: a call's callee resolves to a name ref,
 *  so we gather every `NameRef`/`IdRef` name plus call-target names. */
function invokedNames(model: Model): Set<string> {
  const names = new Set<string>();
  for (const node of AstUtils.streamAst(model)) {
    const n = node as { $type: string; name?: unknown };
    // NameRef / IdRef carry a string `name`; collect it. The walker
    // primitives surface as call callees, which are name refs.
    if (typeof n.name === "string") names.add(n.name);
  }
  return names;
}

describe("conformance: showcase.ddd completeness", () => {
  it(`parses and validates ${SHOWCASE} with no errors`, async () => {
    const doc = await buildShowcase();
    const errors = extractErrors(doc.diagnostics);
    expect(errors, `validation errors in ${SHOWCASE}:\n${errors.join("\n")}`).toEqual([]);
  });

  // Langium validation (above) does not catch IR-level rules that
  // `generate system` enforces (extern-body shape, required create fields,
  // nullable finds in workflows, e2e target resolution).  Run the same
  // lower → enrich → validate pipeline the CLI runs so an ungenerable
  // fixture can't pass the guard.
  it(`lowers and IR-validates ${SHOWCASE} with no errors (generation gate)`, async () => {
    const doc = await buildShowcase();
    const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
    const errors = validateLoomModel(loom)
      .filter((d) => d.severity === "error")
      .map((d) => `${d.source}: ${d.message}`);
    expect(errors, `IR-level errors in ${SHOWCASE} (these block \`generate system\`)`).toEqual([]);
  });

  it("reports AST-node-kind coverage", async () => {
    const doc = await buildShowcase();
    const model = doc.parseResult.value;

    const seen = new Set<string>([model.$type]);
    for (const node of AstUtils.streamAst(model)) seen.add(node.$type);

    const required = reflection
      .getAllTypes()
      .filter((t) => !UNION_SUPERTYPES.has(t) && !ALLOWLIST.has(t));
    const missing = required.filter((t) => !seen.has(t)).sort();

    if (missing.length > 0) {
      console.warn(
        `[showcase coverage] ${missing.length}/${required.length} AST kinds uncovered:\n  ` +
          missing.join("\n  "),
      );
    } else {
      console.info(`[showcase coverage] all ${required.length} AST kinds covered.`);
    }

    if (HARD_GATE) {
      expect(missing, "AST node kinds not exercised by showcase.ddd").toEqual([]);
    }
  });

  it("reports walker-primitive coverage", async () => {
    const doc = await buildShowcase();
    const model = doc.parseResult.value;

    const used = invokedNames(model);
    const primitives = [...STDLIB_LAYOUT_COMPONENTS].sort();
    const missing = primitives.filter((p) => !used.has(p));

    if (missing.length > 0) {
      console.warn(
        `[showcase coverage] ${missing.length}/${primitives.length} walker primitives uncovered:\n  ` +
          missing.join("\n  "),
      );
    } else {
      console.info(`[showcase coverage] all ${primitives.length} walker primitives covered.`);
    }

    if (HARD_GATE) {
      expect(missing, "walker primitives not exercised by showcase.ddd").toEqual([]);
    }
  });
});
