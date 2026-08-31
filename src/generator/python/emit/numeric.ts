// ---------------------------------------------------------------------------
// `app/domain/numeric.py` — cross-backend numeric semantics for the Python
// backend.
//
// TWO cross-backend divergences live here, both about INTEGER division:
//
//   `%`         — Python's `%` is the only FLOORED modulo among Loom's five
//                 backends (see below).
//   `divTrunc`  — the intrinsic exists precisely to give a DETERMINISTIC
//                 truncating division on every backend.  Java/.NET divide two
//                 primitive integers (`a / b`), Elixir emits `div(a, b)`; the
//                 obvious Python spelling `int(a / b)` routes through a float,
//                 so it silently loses precision past 2^53 — and Python is the
//                 one backend whose ints are arbitrary precision, so it is the
//                 one backend where that matters.  `int(10**18 + 7) / 3` gives
//                 333333333333333312; the exact truncation is
//                 333333333333333335, off by 23.  `//` is NOT the answer
//                 either: it FLOORS, so it disagrees with every other backend
//                 on negative operands.  Hence `trunc_div`.
//
// Python's `%` is the only FLOORED modulo among Loom's five backends: its
// result takes the sign of the DIVISOR, so `-5 % 3 == 1`.  TS/JS, C#, Java and
// Elixir (which deliberately emits `rem/2`, not `Integer.mod/2`) all TRUNCATE
// towards zero — the result takes the sign of the DIVIDEND, so `-5 % 3 == -2`.
// A `.ddd` expression must mean the same thing on every backend, so the Python
// renderer lowers `%` to `trunc_mod(...)` from this module rather than to the
// native operator (`render-expr.ts` → `renderBinary`).
//
// Wiring is a single CENTRAL pass over the finished file map
// (`wireNumericHelpers`), not a per-emitter import line.  `%` can appear in a
// derived field, an invariant (which the aggregate module, the Pydantic wire
// validator AND the route module each re-render), a VO function, a domain
// service, a workflow step, a seed, a unit test — a dozen emitters, each with
// its own preamble builder.  Missing one would emit a `NameError` at import
// time, i.e. a silent boot break.  One pass over the emitted text is complete
// by construction: if the call is in the file, the import is too.
// ---------------------------------------------------------------------------

/** The generated helper module.  Value-restricted TypeVar (not `float`) so
 *  `trunc_mod(int, int)` stays `int` under `mypy --strict` — a plain `float`
 *  return would poison every int-typed field it feeds. */
export const NUMERIC_PY = `"""Numeric helpers with cross-backend semantics.  Auto-generated."""

from typing import TypeVar

_N = TypeVar("_N", int, float)


def trunc_mod(a: _N, b: _N) -> _N:
    """Remainder that TRUNCATES towards zero, like C / Java / C# / JS \`%\`.

    Python's native \`%\` floors instead, taking the sign of the divisor
    (\`-5 % 3 == 1\`); every other Loom backend takes the sign of the dividend
    (\`-5 % 3 == -2\`).  This keeps the answer identical across backends.
    """
    m = a % b
    if m != 0 and (a < 0) != (b < 0):
        return m - b
    return m


def trunc_div(a: _N, b: _N) -> _N:
    """Integer division that TRUNCATES towards zero, like C / Java / C# \`/\`.

    This is the \`divTrunc\` intrinsic.  \`int(a / b)\` would round-trip through a
    float and lose precision above 2**53 (Python's ints are arbitrary
    precision, so that loss is real and silent); \`a // b\` is exact but FLOORS,
    disagreeing with every other backend on negative operands.  This spelling
    is both exact and truncating.
    """
    if (a < 0) != (b < 0):
        return -(-a // b)
    return a // b
`;

const HELPER_PATH = "app/domain/numeric.py";

/** One entry per helper the module exports, each wired independently so a
 *  module that calls only one gets only that import (an unused import fails the
 *  generated project's ruff gate on F401). */
const HELPERS: readonly { importLine: string; calls: RegExp }[] = [
  { importLine: "from app.domain.numeric import trunc_mod", calls: /\btrunc_mod\(/ },
  { importLine: "from app.domain.numeric import trunc_div", calls: /\btrunc_div\(/ },
];

/**
 * Emit `app/domain/numeric.py` and give every module that CALLS one of its
 * helpers the matching import — a no-op when nothing in the project uses `%`
 * or `divTrunc`.
 *
 * The import lands directly after the module docstring, at the head of the
 * import block.  Generated projects pin ruff's lint scope to `E4/E7/E9 + F`
 * (see the emitted `pyproject.toml`), so isort's grouping rule (`I001`) is not
 * in play and placement only has to be syntactically valid.
 */
export function wireNumericHelpers(out: Map<string, string>): void {
  let used = false;
  for (const [path, content] of out) {
    if (path === HELPER_PATH) continue;
    let next = content;
    for (const h of HELPERS) {
      if (!h.calls.test(next) || next.includes(h.importLine)) continue;
      used = true;
      next = insertImport(next, h.importLine);
    }
    if (next !== content) out.set(path, next);
  }
  if (used) out.set(HELPER_PATH, NUMERIC_PY);
}

/** Splice the import in after a leading module docstring (every generated
 *  module opens with one), else at the very top. */
function insertImport(content: string, importLine: string): string {
  const lines = content.split("\n");
  // A one-line `"""…"""` docstring is the emitters' universal opener; anything
  // else (no docstring, or a multi-line one) falls back to a top insert, which
  // is still valid Python — it just isn't the file's own docstring any more,
  // so only do it when line 0 clearly isn't one.
  const head = lines[0] ?? "";
  const hasDocstring = head.startsWith('"""') && head.endsWith('"""') && head.length > 5;
  lines.splice(hasDocstring ? 1 : 0, 0, ...(hasDocstring ? ["", importLine] : [importLine, ""]));
  return lines.join("\n");
}
