import { ParameterInformation, SignatureInformation } from "vscode-languageserver";
import type { TypeRef } from "../generated/ast.js";
import { resolveTypeRef, typeToString } from "../type-system.js";

// ---------------------------------------------------------------------------
// Shared parameter / signature rendering, so hover and signature-help agree
// on how a parameter list reads.
// ---------------------------------------------------------------------------

export function paramSig(p: { name: string; type: TypeRef }): string {
  return `${p.name}: ${typeToString(resolveTypeRef(p.type))}`;
}

export function buildSignature(
  name: string,
  params: ReadonlyArray<{ name: string; type: TypeRef }>,
  ret?: TypeRef,
  style: "()" | "{}" = "()",
): SignatureInformation {
  const paramStrs = params.map(paramSig);
  const retStr = ret ? `: ${typeToString(resolveTypeRef(ret))}` : "";
  const [open, close] = style === "{}" ? [" { ", " }"] : ["(", ")"];
  const label = `${name}${open}${paramStrs.join(", ")}${close}${retStr}`;
  const parameters: ParameterInformation[] = paramStrs.map((s) => ParameterInformation.create(s));
  return SignatureInformation.create(label, undefined, ...parameters);
}
