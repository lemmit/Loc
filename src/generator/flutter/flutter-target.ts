// The Flutter WalkerTarget — Dart/Flutter seam implementations consumed by the
// shared `walkBody` engine.  Flutter is structurally a Feliz clone: a non-JSX,
// function-call-tree target (`Column(children: [ … ])`), so it rides the shared
// walker core through this seam object rather than adding a WALKER_PRIMITIVE.
//
// PHASE 0 STATUS: this is a STUB.  Every REQUIRED member of the `WalkerTarget`
// contract is present and type-checks with a placeholder body (a
// `/* TODO flutter: … */` Dart comment or a trivial passthrough), so the object
// satisfies the interface end-to-end.  The Phase 1 fan-out tracks fill the real
// Dart lowering in place; getting the interface SHAPE right is the point here.
//
// The OPTIONAL members (whole-primitive overrides — `renderCreateForm` /
// `renderOperationForm` / `renderModal` / `renderWorkflowForm` /
// `renderDestroyForm` / `renderAction` / `renderUserComponent` — plus the
// interactive-table + store seams) are intentionally omitted for now: an
// omitted optional falls back to the shared JSX-shaped path, which the Phase 1
// tracks will override once the Dart forms/actions surface exists.

import type { WalkerTarget } from "../_walker/target.js";

export const flutterTarget: WalkerTarget = {
  framework: "flutter",

  // --- State seam ---------------------------------------------------------
  renderStateRead: (ref) => ref.name,
  renderStateWrite: (ref, value) => `/* TODO flutter: state ${ref.name} := ${value} */`,
  renderNestedStateWrite: (segments, valueJs) =>
    `/* TODO flutter: state ${segments.join(".")} := ${valueJs} */`,

  // --- API binding seam ---------------------------------------------------
  buildHookUse: (detected) => ({
    varName: detected.aggregateName,
    hookName: detected.aggregateName,
    importFrom: "",
    argsRendered: [],
  }),
  renderApiCall: (call) => `/* TODO flutter: api ${call.aggregateName}.${call.operation} */`,
  renderApiHoisting: () => [],

  // --- Match expression seam ----------------------------------------------
  renderMatch: (arms, elseArm) =>
    `/* TODO flutter: match (${arms.length} arm(s)${elseArm ? ", else" : ""}) */`,
  renderMatchChild: (arms, elseArm) =>
    `/* TODO flutter: match-child (${arms.length} arm(s)${elseArm ? ", else" : ""}) */`,

  // --- List-comprehension seam --------------------------------------------
  renderForEach: (coll, itemVar) => `/* TODO flutter: For ${itemVar} in ${coll} */`,

  // --- Navigation seam ----------------------------------------------------
  renderNavigate: (routeTemplate) => `/* TODO flutter: navigate ${routeTemplate} */`,

  // --- Type-default seam --------------------------------------------------
  defaultInitFor: () => "null",

  // --- Markup seams -------------------------------------------------------
  renderComment: (text) => `/* ${text} */`,
  renderInterpolation: (jsExpr) => `/* TODO flutter: text ${jsExpr} */`,
  renderAttrBinding: (name, jsExpr) => `/* TODO flutter: attr ${name}=${jsExpr} */`,
  renderConditionalChild: (cond, thenS, elseS) => `(${cond} ? ${thenS} : ${elseS})`,
  renderStyleAttr: () => "",
  escapeText: (text) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),

  // --- Expression-syntax leaves (Dart) — placeholder passthroughs ---------
  exprLiteral: (_lit, value) => value,
  exprBinary: (left, right, op) => `(${left} ${op} ${right})`,
  exprUnary: (op, operand) => `(${op}${operand})`,
  exprTernary: (cond, then, otherwise) => `(${cond} ? ${then} : ${otherwise})`,
  exprConvert: (value) => value,
  exprList: (elements) => `[${elements.join(", ")}]`,
  exprObject: (fields) => `{${fields.map((f) => `'${f.name}': ${f.value}`).join(", ")}}`,
};
