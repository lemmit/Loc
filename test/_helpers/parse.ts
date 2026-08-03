import { type Diagnostic, EmptyFileSystem, type LangiumDocument, type URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

export type ParseResult = {
  model: Model;
  doc: LangiumDocument<Model>;
  diagnostics: Diagnostic[];
  errors: string[];
  warnings: string[];
};

/** Diagnostic severity 1 === Error in the LSP protocol. */
const isError = (d: Diagnostic): boolean => d.severity === 1;
const isWarning = (d: Diagnostic): boolean => d.severity === 2;

const fmt = (d: Diagnostic): string =>
  `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`;

export const extractErrors = (diagnostics: readonly Diagnostic[] = []): string[] =>
  diagnostics.filter(isError).map(fmt);

export const extractWarnings = (diagnostics: readonly Diagnostic[] = []): string[] =>
  diagnostics.filter(isWarning).map(fmt);

// One shared service instance for every `parseString` call.
//
// Constructing the services is cheap (~1% of a parse), but the Chevrotain
// parser it lazily builds on FIRST parse is not: a fresh instance per call
// costs ~173ms, a shared one ~19ms — a 9x difference across a suite that
// parses thousands of times.
//
// The catch is that `parseHelper` mints a new URI per call (`file:///1.ddd`,
// `2.ddd`, …) and leaves each document in the shared workspace, so documents
// ACCUMULATE and later parses link against earlier ones.  That is not a
// slow leak, it is a correctness hole: a doc referencing an undeclared
// `Ghost id` resolves happily against a `Ghost` some earlier test declared,
// so every "could not resolve" negative would pass vacuously.  Verified
// directly — shared-without-eviction reports 0 errors where a fresh instance
// reports 1.
//
// So: share the instance, and evict so each call sees exactly its own document,
// as before.  See `evictPrevious` for why the eviction happens on the way IN.
let _services: ReturnType<typeof createDddServices> | undefined;
const sharedServices = (): ReturnType<typeof createDddServices> =>
  (_services ??= createDddServices(NodeFileSystem));

/** URI of the last document `parseString` built, pending eviction. */
let _previousUri: URI | undefined;

async function evictPrevious(services: ReturnType<typeof createDddServices>): Promise<void> {
  if (_previousUri === undefined) return;
  const uri = _previousUri;
  _previousUri = undefined;
  await services.shared.workspace.DocumentBuilder.update([], [uri]);
}

/**
 * Parse an in-memory `.ddd` source string and (by default) run validation.
 * Replaces the `parseHelper(services.Ddd)` + diagnostics-filter boilerplate
 * duplicated across the suite.
 */
export async function parseString(
  source: string,
  { validate = true }: { validate?: boolean } = {},
): Promise<ParseResult> {
  const services = sharedServices();
  // Evict the PREVIOUS parse before this one, not this one after itself.
  //
  // `LangiumDocuments.deleteDocument` alone is not enough — it drops the
  // document but leaves its exported symbols in the IndexManager's global
  // scope, so the next parse still links against them (verified: the `Ghost`
  // reference above still resolved).  Routing the deletion through the
  // DocumentBuilder does invalidate the index — but it also RESETS the deleted
  // document below ComputedScopes, and callers keep walking the AST we return
  // (`Attempted reference resolution before document reached ComputedScopes`).
  //
  // Evicting on the way IN satisfies both: this parse sees an empty workspace,
  // and the document we hand back is left fully linked.
  await evictPrevious(services);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(source, { validation: validate });
  _previousUri = doc.uri;
  const diagnostics = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    doc,
    diagnostics,
    errors: extractErrors(diagnostics),
    warnings: extractWarnings(diagnostics),
  };
}

/** Parse and assert no validation errors, returning the Model. */
export async function parseValid(source: string): Promise<Model> {
  const { model, errors } = await parseString(source, { validate: true });
  if (errors.length) {
    throw new Error(`unexpected validation errors:\n${errors.join("\n")}`);
  }
  return model;
}

// Lazily-built standalone parser for the link-free, synchronous AST path
// (no document builder, no validation, no cross-reference linking). The
// LangiumParser is stateless across calls, so a single shared instance is safe.
let _rawParser: ReturnType<typeof createDddServices>["Ddd"]["parser"]["LangiumParser"] | undefined;
const rawParser = () => {
  _rawParser ??= createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
  return _rawParser;
};

/** Synchronous, link-free parse to a raw AST Model (no validation/linking). */
export const parseRaw = (text: string): Model => rawParser().parse(text).value as Model;

/** True when `text` parses with no parser (syntax) errors. */
export const parseRawOk = (text: string): boolean =>
  rawParser().parse(text).parserErrors.length === 0;

/** Full link-free parse result (carries `.value` and `.parserErrors`). */
export const parseRawResult = (text: string) => rawParser().parse(text);
