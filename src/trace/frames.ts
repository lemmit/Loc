// ---------------------------------------------------------------------------
// Stack-frame parsing — the first step of `ddd trace` (docs/proposals/
// source-map-and-debugging.md §6B).  Recognizes one stack-frame line per
// backend's native crash-log dialect and reduces it to a
// `{file, line}` (for Java `{file, line, javaFqn}`; for V8/Node
// `{file, line, col}` — the only dialect that carries a column) tuple that
// `resolve.ts` can match against `.loom/sourcemap.json`.
//
// Pure and dependency-free (no `fs`, no Node APIs) — browser-safe, like
// `src/verify/`.  Five formats, tried per log line, first match wins:
//
//   - V8/Node   `at fn (/p/file.ts:47:12)` | `at /p/file.ts:47:12`
//   - .NET      `at Ns.Class.Method() in /p/File.cs:line 47`
//   - Java      `at com.acme.app.Foo.bar(Foo.java:47)` — carries the FQN
//               (class + method) so `resolve.ts` can derive the on-disk
//               `<package-path>/<File>.java` suffix from it.
//   - Python    `File "/p/file.py", line 47, in fn`
//   - Elixir    `(app 0.1.0) lib/app/foo.ex:47: Mod.fun/2` and the bare
//               `lib/app/foo.ex:47: Mod.fun/2` shape (no leading `(app vsn)`)
//
// A line that names a negative line number never matches — every format's
// line-number group is `\d+`, which cannot consume a leading `-`.
// ---------------------------------------------------------------------------

/** One recognized stack frame.  `line` is 1-based, as every native
 *  runtime reports it. `javaFqn` is set only for a Java frame — the
 *  dotted `pkg.pkg.Class.method` the frame line names. `col` (1-based,
 *  same base as `WireRegion.targetCol` in `resolve.ts`) is set only for a
 *  V8/Node frame — the only dialect this slice's native frames carry a
 *  column for (.NET/Java/Python/Elixir formats have no column and keep
 *  today's line-only behavior). */
export interface ParsedFrame {
  /** 0-based index into `logText.split("\n")` — lets `annotate.ts` splice
   *  the annotation back onto the exact source line. */
  lineIndex: number;
  file?: string;
  line?: number;
  javaFqn?: string;
  col?: number;
}

// Order doesn't affect correctness here (each format's trailing shape is
// distinct enough that none accidentally matches another's line — see the
// module comment in test/trace/frames.test.ts for the cross-format check),
// but the more specific dialects are tried before the generic V8 pattern.

/** `at Ns.Class.Method() in /p/File.cs:line 47` */
const DOTNET_RE = /^\s*at\s+.+?\s+in\s+(.+):line\s+(\d+)\s*$/;

/** `at com.acme.app.Foo.bar(Foo.java:47)` — group 1 is the full dotted
 *  `pkg.pkg.Class.method` (javaFqn); group 2/3 are the `.java` basename
 *  and line the parens name directly. */
const JAVA_RE = /^\s*at\s+([\w$]+(?:\.[\w$]+)+)\(([\w$]+\.java):(\d+)\)\s*$/;

/** `File "/p/file.py", line 47, in fn` */
const PYTHON_RE = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+.+)?\s*$/;

/** `(app 0.1.0) lib/app/foo.ex:47: Mod.fun/2` */
const ELIXIR_APP_RE = /^\s*\([\w.-]+\s+[\d.]+\)\s+(\S+\.ex):(\d+):/;

/** bare `lib/app/foo.ex:47: Mod.fun/2` (no leading `(app vsn)`) */
const ELIXIR_BARE_RE = /^\s*(\S+\.ex):(\d+):/;

/** `at fn (/p/file.ts:47:12)` | `at /p/file.ts:47:12` */
const NODE_RE = /^\s*at\s+(?:.*?\()?(.+):(\d+):(\d+)\)?\s*$/;

function parseLine(line: string): Omit<ParsedFrame, "lineIndex"> | undefined {
  let m = DOTNET_RE.exec(line);
  if (m) return { file: m[1], line: Number(m[2]) };

  m = JAVA_RE.exec(line);
  if (m) return { file: m[2], line: Number(m[3]), javaFqn: m[1] };

  m = PYTHON_RE.exec(line);
  if (m) return { file: m[1], line: Number(m[2]) };

  m = ELIXIR_APP_RE.exec(line);
  if (m) return { file: m[1], line: Number(m[2]) };

  m = ELIXIR_BARE_RE.exec(line);
  if (m) return { file: m[1], line: Number(m[2]) };

  m = NODE_RE.exec(line);
  // V8 columns are 1-based — the same base `WireRegion.targetCol` uses, so
  // `resolve.ts` compares the two directly with no adjustment.
  if (m) return { file: m[1], line: Number(m[2]), col: Number(m[3]) };

  return undefined;
}

/** Parse every recognized stack-frame line out of a crash log / stack
 *  trace.  Lines that match no known dialect (headers, exception
 *  messages, blank lines) are simply absent from the result — `annotate.ts`
 *  leaves them untouched. */
export function parseFrames(logText: string): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  const lines = logText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]!);
    if (parsed) out.push({ lineIndex: i, ...parsed });
  }
  return out;
}
