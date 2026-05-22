import type { Diagnostic, LangiumDocument } from "langium";
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

/**
 * Parse an in-memory `.ddd` source string and (by default) run validation.
 * Replaces the `parseHelper(services.Ddd)` + diagnostics-filter boilerplate
 * duplicated across the suite.
 */
export async function parseString(
  source: string,
  { validate = true }: { validate?: boolean } = {},
): Promise<ParseResult> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(source, { validation: validate });
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
