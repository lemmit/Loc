import { createContext, useContext, useEffect, useState } from "react";
import { ActionIcon, Autocomplete, Box, Button, Group, SegmentedControl, Select, Text, TextInput, Textarea } from "@mantine/core";
import { ASSIGN_OPS, BINARY_OPS, UNARY_OPS, emitExpr, type ECallArg, type EExpr, type EMatchArm, type EObjField, type EStmt } from "./expr-model";

export type ExprMode = "structured" | "text";

// In-scope bare names for the expression being edited (params, properties,
// derived props, enum values…). Threaded to every `raw` leaf so they offer
// scope-aware suggestions while staying free-text.
const ExprScopeContext = createContext<string[]>([]);

// Type-directed member-name candidates per member node, keyed by the canonical
// structural path (see `exprHints` in expr-slots.ts). Computed against a
// linked document (async), so it's empty until that resolves — member inputs
// stay free-text either way.
const MemberCandidatesContext = createContext<Map<string, string[]>>(new Map());

// Callee parameter names per call / member-call node (same path key), to label
// the positional argument slots (`amount:`, `currency:`). Empty until the async
// linked build resolves.
const ArgLabelsContext = createContext<Map<string, string[]>>(new Map());

// Recursive structured expression editor. Operator nodes (binary/unary/paren)
// render dropdowns + nested operands; literals render typed inputs; everything
// else is a `raw` text leaf. `onChange(next, commit)` bubbles the full updated
// subtree up: live edits pass commit=false; discrete changes (operator/bool
// select) and text-leaf blur pass commit=true so the surface splices + re-parses.

interface NodeProps {
  node: EExpr;
  /** Canonical structural path of this node (root is ""), used to look up
   *  type-directed member candidates. See `memberCandidates` in expr-slots.ts. */
  path: string;
  onChange: (next: EExpr, commit: boolean) => void;
}

// Argument list shared by call (`f(…)`) and member-call (`a.b(…)`) nodes.
// Edits a single arg's value or name, removes an arg, or appends a positional
// one (defaulting to `null` so the result stays parseable until edited). A named
// arg's name is editable (clearing it makes the arg positional).
function ArgsEditor({ args, path, onArgs }: { args: ECallArg[]; path: string; onArgs: (args: ECallArg[], commit: boolean) => void }): JSX.Element {
  // Callee parameter names (type-resolved) to label positional args.
  const paramNames = useContext(ArgLabelsContext).get(path);
  const setName = (i: number, name: string | undefined, commit: boolean): void =>
    onArgs(args.map((a, j) => (j === i ? { ...a, name } : a)), commit);
  // On blur, an emptied name demotes the arg back to positional.
  const normalizeName = (i: number): void =>
    onArgs(args.map((a, j) => (j === i && a.name?.trim() === "" ? { ...a, name: undefined } : a)), true);
  return (
    <Group gap={2} wrap="nowrap" align="center">
      <Text size="xs" c="dimmed">(</Text>
      {args.map((arg, i) => (
        <Group key={i} gap={2} wrap="nowrap" align="center">
          {i > 0 && <Text size="xs" c="dimmed">,</Text>}
          {arg.name !== undefined ? (
            <Group gap={0} wrap="nowrap" align="center">
              <TextInput
                size="xs"
                w={64}
                value={arg.name}
                data-testid="c4expr-arg-name"
                aria-label="argument name"
                styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
                onChange={(e) => setName(i, e.currentTarget.value, false)}
                onBlur={() => normalizeName(i)}
              />
              <Text size="xs" c="dimmed">:</Text>
            </Group>
          ) : paramNames?.[i] ? (
            <Text size="xs" c="dimmed" data-testid="c4expr-arg-label" title="parameter (click to name)" style={{ cursor: "pointer" }} onClick={() => setName(i, paramNames[i], true)}>{paramNames[i]}:</Text>
          ) : null}
          <ExpressionEditor node={arg.value} path={`${path}a${i}`} onChange={(n, c) => onArgs(args.map((a, j) => (j === i ? { ...a, value: n } : a)), c)} />
          <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-arg-del" aria-label="remove argument" onClick={() => onArgs(args.filter((_, j) => j !== i), true)}>
            <Text size="xs">×</Text>
          </ActionIcon>
        </Group>
      ))}
      <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-arg-add" aria-label="add argument" onClick={() => onArgs([...args, { value: { kind: "lit", lit: "null", value: "null" } }], true)}>
        <Text size="xs">+</Text>
      </ActionIcon>
      <Text size="xs" c="dimmed">)</Text>
    </Group>
  );
}

// Named-field list for `new Part { … }` and object literals `{ … }`. Edits a
// field's name or value, removes a field, or appends one (defaulting to
// `field: null` so the result stays parseable until edited).
function FieldsEditor({ fields, path, onFields }: { fields: EObjField[]; path: string; onFields: (fields: EObjField[], commit: boolean) => void }): JSX.Element {
  return (
    <Group gap={2} wrap="nowrap" align="center">
      <Text size="xs" c="dimmed">{"{"}</Text>
      {fields.map((field, i) => (
        <Group key={i} gap={2} wrap="nowrap" align="center">
          {i > 0 && <Text size="xs" c="dimmed">,</Text>}
          <TextInput
            size="xs"
            w={80}
            value={field.name}
            data-testid="c4expr-field-name"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onFields(fields.map((f, j) => (j === i ? { ...f, name: e.currentTarget.value } : f)), false)}
            onBlur={() => onFields(fields, true)}
          />
          <Text size="xs" c="dimmed">:</Text>
          <ExpressionEditor node={field.value} path={`${path}f${i}`} onChange={(n, c) => onFields(fields.map((f, j) => (j === i ? { ...f, value: n } : f)), c)} />
          <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-field-del" aria-label="remove field" onClick={() => onFields(fields.filter((_, j) => j !== i), true)}>
            <Text size="xs">×</Text>
          </ActionIcon>
        </Group>
      ))}
      <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-field-add" aria-label="add field" onClick={() => onFields([...fields, { name: "field", value: { kind: "lit", lit: "null", value: "null" } }], true)}>
        <Text size="xs">+</Text>
      </ActionIcon>
      <Text size="xs" c="dimmed">{"}"}</Text>
    </Group>
  );
}

// One statement row of a block-bodied lambda. `let` / assignment structure their
// value as a nested expression editor (the lambda param + earlier `let` bindings
// are threaded into its scope); every other statement kind edits as a verbatim
// text row.
function StmtRow({ stmt, path, scope, onChange, onDelete, onMoveUp, onMoveDown }: {
  stmt: EStmt;
  path: string;
  scope: string[];
  onChange: (s: EStmt, commit: boolean) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}): JSX.Element {
  const valueEditor = (value: EExpr, on: (n: EExpr, c: boolean) => void): JSX.Element => (
    <ExprScopeContext.Provider value={scope}>
      <ExpressionEditor node={value} path={`${path}v`} onChange={on} />
    </ExprScopeContext.Provider>
  );
  return (
    <Group gap={2} wrap="nowrap" align="center" data-testid="c4expr-stmt">
      {stmt.kind === "let" && (
        <>
          <Text size="xs" c="dimmed">let</Text>
          <TextInput
            size="xs"
            w={56}
            value={stmt.name}
            data-testid="c4expr-stmt-let-name"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onChange({ ...stmt, name: e.currentTarget.value }, false)}
            onBlur={() => onChange(stmt, true)}
          />
          <Text size="xs" c="dimmed">=</Text>
          {valueEditor(stmt.value, (n, c) => onChange({ ...stmt, value: n }, c))}
        </>
      )}
      {stmt.kind === "assign" && (
        <>
          <TextInput
            size="xs"
            w={70}
            value={stmt.target}
            data-testid="c4expr-stmt-target"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onChange({ ...stmt, target: e.currentTarget.value }, false)}
            onBlur={() => onChange(stmt, true)}
          />
          <Select size="xs" w={56} data={ASSIGN_OPS} value={stmt.op} allowDeselect={false} data-testid="c4expr-stmt-op" onChange={(op) => op && onChange({ ...stmt, op }, true)} />
          {valueEditor(stmt.value, (n, c) => onChange({ ...stmt, value: n }, c))}
        </>
      )}
      {stmt.kind === "raw" && (
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          value={stmt.src}
          data-testid="c4expr-stmt-raw"
          styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
          onChange={(e) => onChange({ ...stmt, src: e.currentTarget.value }, false)}
          onBlur={() => onChange(stmt, true)}
        />
      )}
      {onMoveUp && (
        <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-stmt-up" aria-label="move statement up" onClick={onMoveUp}>
          <Text size="xs">↑</Text>
        </ActionIcon>
      )}
      {onMoveDown && (
        <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-stmt-down" aria-label="move statement down" onClick={onMoveDown}>
          <Text size="xs">↓</Text>
        </ActionIcon>
      )}
      <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-stmt-del" aria-label="remove statement" onClick={onDelete}>
        <Text size="xs">×</Text>
      </ActionIcon>
    </Group>
  );
}

export function ExpressionEditor({ node, path, onChange }: NodeProps): JSX.Element {
  const candidates = useContext(ExprScopeContext);
  const memberMap = useContext(MemberCandidatesContext);
  switch (node.kind) {
    case "binary":
      return (
        <Group gap={4} wrap="nowrap" align="center" style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }}>
          <ExpressionEditor node={node.left} path={`${path}L`} onChange={(n, c) => onChange({ ...node, left: n }, c)} />
          <Select
            size="xs"
            w={64}
            data={BINARY_OPS}
            value={node.op}
            allowDeselect={false}
            data-testid="c4expr-op"
            onChange={(op) => op && onChange({ ...node, op }, true)}
          />
          <ExpressionEditor node={node.right} path={`${path}R`} onChange={(n, c) => onChange({ ...node, right: n }, c)} />
        </Group>
      );
    case "unary":
      return (
        <Group gap={2} wrap="nowrap" align="center">
          <Select size="xs" w={48} data={UNARY_OPS} value={node.op} allowDeselect={false} onChange={(op) => op && onChange({ ...node, op }, true)} />
          <ExpressionEditor node={node.operand} path={`${path}o`} onChange={(n, c) => onChange({ ...node, operand: n }, c)} />
        </Group>
      );
    case "paren":
      return (
        <Group gap={2} wrap="nowrap" align="center">
          <Text size="xs" c="dimmed">(</Text>
          <ExpressionEditor node={node.inner} path={`${path}i`} onChange={(n, c) => onChange({ ...node, inner: n }, c)} />
          <Text size="xs" c="dimmed">)</Text>
        </Group>
      );
    case "lit":
      if (node.lit === "bool") {
        return (
          <Select size="xs" w={70} data={["true", "false"]} value={node.value} allowDeselect={false} data-testid="c4expr-lit" onChange={(v) => v && onChange({ ...node, value: v }, true)} />
        );
      }
      if (node.lit === "null") return <Text size="xs" ff="monospace">null</Text>;
      return (
        <TextInput
          size="xs"
          w={node.lit === "string" ? 120 : 70}
          value={node.value}
          data-testid="c4expr-lit"
          styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
          onChange={(e) => onChange({ ...node, value: e.currentTarget.value }, false)}
          onBlur={() => onChange(node, true)}
        />
      );
    case "call":
      return (
        <Group gap={1} wrap="nowrap" align="center" style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }}>
          <ExpressionEditor node={node.callee} path={`${path}c`} onChange={(n, c) => onChange({ ...node, callee: n }, c)} />
          <ArgsEditor args={node.args} path={path} onArgs={(args, c) => onChange({ ...node, args }, c)} />
        </Group>
      );
    case "member":
      return (
        <Group gap={1} wrap="nowrap" align="center">
          <ExpressionEditor node={node.receiver} path={`${path}r`} onChange={(n, c) => onChange({ ...node, receiver: n }, c)} />
          <Text size="xs" c="dimmed">.</Text>
          <Autocomplete
            size="xs"
            w={90}
            value={node.member}
            data={memberMap.get(path) ?? []}
            data-testid="c4expr-member"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(v) => onChange({ ...node, member: v }, false)}
            onBlur={() => onChange(node, true)}
          />
          {node.call && <ArgsEditor args={node.args} path={path} onArgs={(args, c) => onChange({ ...node, args }, c)} />}
        </Group>
      );
    case "lambda":
      return (
        <Group gap={2} wrap="nowrap" align="center">
          <TextInput
            size="xs"
            w={48}
            value={node.param}
            data-testid="c4expr-lambda-param"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onChange({ ...node, param: e.currentTarget.value }, false)}
            onBlur={() => onChange(node, true)}
          />
          <Text size="xs" c="dimmed">{"=>"}</Text>
          {/* The lambda param is in scope for its body. */}
          <ExprScopeContext.Provider value={[...candidates, node.param]}>
            <ExpressionEditor node={node.body} path={`${path}b`} onChange={(n, c) => onChange({ ...node, body: n }, c)} />
          </ExprScopeContext.Provider>
        </Group>
      );
    case "blockLambda": {
      const bl = node;
      const setStmts = (stmts: EStmt[], commit: boolean): void => onChange({ ...bl, stmts }, commit);
      // Earlier `let` bindings are in scope for a later statement's value.
      const letNamesBefore = (i: number): string[] => bl.stmts.slice(0, i).flatMap((s) => (s.kind === "let" ? [s.name] : []));
      const move = (i: number, d: number): void => {
        const next = bl.stmts.slice();
        [next[i], next[i + d]] = [next[i + d], next[i]];
        setStmts(next, true);
      };
      return (
        <Box style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }} data-testid="c4expr-block-lambda">
          <Group gap={2} wrap="nowrap" align="center">
            <TextInput
              size="xs"
              w={48}
              value={bl.param}
              data-testid="c4expr-blocklambda-param"
              styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
              onChange={(e) => onChange({ ...bl, param: e.currentTarget.value }, false)}
              onBlur={() => onChange(bl, true)}
            />
            <Text size="xs" c="dimmed">{"=> {"}</Text>
          </Group>
          {bl.stmts.map((s, i) => (
            <Box key={i} pl={8}>
              <StmtRow
                stmt={s}
                path={`${path}s${i}`}
                scope={[...candidates, bl.param, ...letNamesBefore(i)]}
                onChange={(ns, c) => setStmts(bl.stmts.map((x, j) => (j === i ? ns : x)), c)}
                onDelete={() => setStmts(bl.stmts.filter((_, j) => j !== i), true)}
                onMoveUp={i > 0 ? () => move(i, -1) : undefined}
                onMoveDown={i < bl.stmts.length - 1 ? () => move(i, 1) : undefined}
              />
            </Box>
          ))}
          <Group gap={4} pl={8} mt={2}>
            <Button size="compact-xs" variant="subtle" color="gray" data-testid="c4expr-stmt-add-let" onClick={() => setStmts([...bl.stmts, { kind: "let", name: "x", value: { kind: "lit", lit: "null", value: "null" } }], true)}>
              + let
            </Button>
            <Button size="compact-xs" variant="subtle" color="gray" data-testid="c4expr-stmt-add-assign" onClick={() => setStmts([...bl.stmts, { kind: "assign", target: bl.param, op: ":=", value: { kind: "lit", lit: "null", value: "null" } }], true)}>
              + assign
            </Button>
          </Group>
          <Text size="xs" c="dimmed">{"}"}</Text>
        </Box>
      );
    }
    case "ternary":
      return (
        <Group gap={4} wrap="nowrap" align="center" style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }} data-testid="c4expr-ternary">
          <ExpressionEditor node={node.cond} path={`${path}?c`} onChange={(n, c) => onChange({ ...node, cond: n }, c)} />
          <Text size="xs" c="dimmed">?</Text>
          <ExpressionEditor node={node.then} path={`${path}?t`} onChange={(n, c) => onChange({ ...node, then: n }, c)} />
          <Text size="xs" c="dimmed">:</Text>
          <ExpressionEditor node={node.else} path={`${path}?e`} onChange={(n, c) => onChange({ ...node, else: n }, c)} />
        </Group>
      );
    case "match": {
      const m = node;
      const setArm = (i: number, arm: EMatchArm, commit: boolean): void => onChange({ ...m, arms: m.arms.map((a, j) => (j === i ? arm : a)), }, commit);
      return (
        <Box style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }} data-testid="c4expr-match">
          <Text size="xs" c="dimmed">match</Text>
          {m.arms.map((arm, i) => (
            <Group key={i} gap={4} wrap="nowrap" align="center" pl={8}>
              <ExpressionEditor node={arm.cond} path={`${path}m${i}c`} onChange={(n, c) => setArm(i, { ...arm, cond: n }, c)} />
              <Text size="xs" c="dimmed">{"=>"}</Text>
              <ExpressionEditor node={arm.value} path={`${path}m${i}v`} onChange={(n, c) => setArm(i, { ...arm, value: n }, c)} />
              <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-arm-del" aria-label="remove arm" onClick={() => onChange({ ...m, arms: m.arms.filter((_, j) => j !== i) }, true)}>
                <Text size="xs">×</Text>
              </ActionIcon>
            </Group>
          ))}
          {m.else !== undefined && (
            <Group gap={4} wrap="nowrap" align="center" pl={8}>
              <Text size="xs" c="dimmed">else {"=>"}</Text>
              <ExpressionEditor node={m.else} path={`${path}me`} onChange={(n, c) => onChange({ ...m, else: n }, c)} />
              <ActionIcon size="xs" variant="subtle" color="gray" data-testid="c4expr-else-del" aria-label="remove else" onClick={() => onChange({ ...m, else: undefined }, true)}>
                <Text size="xs">×</Text>
              </ActionIcon>
            </Group>
          )}
          <Group gap={4} pl={8} mt={2}>
            <Button size="compact-xs" variant="subtle" color="gray" data-testid="c4expr-arm-add" onClick={() => onChange({ ...m, arms: [...m.arms, { cond: { kind: "lit", lit: "bool", value: "true" }, value: { kind: "lit", lit: "null", value: "null" } }] }, true)}>
              + arm
            </Button>
            {m.else === undefined && (
              <Button size="compact-xs" variant="subtle" color="gray" data-testid="c4expr-else-add" onClick={() => onChange({ ...m, else: { kind: "lit", lit: "null", value: "null" } }, true)}>
                + else
              </Button>
            )}
          </Group>
        </Box>
      );
    }
    case "builder":
      return (
        <Group gap={2} wrap="nowrap" align="center" style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }}>
          <TextInput
            size="xs"
            w={90}
            value={node.type}
            data-testid="c4expr-builder-type"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onChange({ ...node, type: e.currentTarget.value }, false)}
            onBlur={() => onChange(node, true)}
          />
          <Text size="xs" c="dimmed">{"{"}</Text>
          <ArgsEditor args={node.entries} path={path} onArgs={(entries, c) => onChange({ ...node, entries }, c)} />
          <Text size="xs" c="dimmed">{"}"}</Text>
        </Group>
      );
    case "object":
      return <FieldsEditor fields={node.fields} path={path} onFields={(fields, c) => onChange({ ...node, fields }, c)} />;
    case "raw":
      return (
        <Autocomplete
          size="xs"
          w={150}
          value={node.text}
          data={candidates}
          data-testid="c4expr-raw"
          styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
          onChange={(v) => onChange({ ...node, text: v }, false)}
          onBlur={() => onChange(node, true)}
        />
      );
  }
}

// Advanced escape hatch: edit the whole expression as raw text, validated by
// the same reparse-on-commit path. `seedText` is the verbatim source slice.
function ExprTextField({ seedText, onCommit }: { seedText: string; onCommit: (text: string) => boolean }): JSX.Element {
  const [error, setError] = useState(false);
  return (
    <Textarea
      size="xs"
      autosize
      minRows={1}
      defaultValue={seedText}
      error={error ? "invalid expression" : undefined}
      data-testid="c4expr-text"
      styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
      onFocus={() => error && setError(false)}
      onBlur={(e) => {
        const v = e.currentTarget.value;
        if (v.trim() !== seedText.trim() && !onCommit(v)) setError(true);
      }}
    />
  );
}

// Surface wrapper: owns the working tree, commits on discrete change / blur via
// `onCommit(text)`. A failed commit (unparseable) is flagged and the working
// tree kept so the user can fix it; on success the parent re-seeds (remount via
// a rev-keyed mount), which clears the error. A structured⇄text toggle lets
// advanced users drop to raw text (still reparse-validated); `mode` is held by
// the parent so it persists across the rev-keyed remount.
export function ExprSlotEditor({
  seed,
  seedText,
  candidates,
  loadHints,
  mode,
  onMode,
  onCommit,
}: {
  seed: EExpr;
  seedText: string;
  candidates: string[];
  /** Resolves type-directed hints (member candidates + call arg labels) per node
   *  path. Async (builds a linked document); run once on mount — the parent
   *  re-keys this component per slot/revision, so a fresh slot or a commit
   *  remounts and recomputes. */
  loadHints: () => Promise<{ members: Map<string, string[]>; argLabels: Map<string, string[]> }>;
  mode: ExprMode;
  onMode: (mode: ExprMode) => void;
  onCommit: (text: string) => boolean;
}): JSX.Element {
  const [local, setLocal] = useState(seed);
  const [error, setError] = useState(false);
  const [memberMap, setMemberMap] = useState<Map<string, string[]>>(new Map());
  const [argLabels, setArgLabels] = useState<Map<string, string[]>>(new Map());
  const handle = (next: EExpr, commit: boolean): void => {
    setLocal(next);
    if (commit && !onCommit(emitExpr(next))) setError(true);
  };
  useEffect(() => {
    let alive = true;
    void loadHints().then((h) => {
      if (!alive) return;
      setMemberMap(h.members);
      setArgLabels(h.argLabels);
    });
    return () => { alive = false; };
    // Run once per mount; the rev/slot-keyed remount drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Box data-testid="c4expr">
      <SegmentedControl
        size="xs"
        mb={4}
        data={[
          { label: "Structured", value: "structured" },
          { label: "Text", value: "text" },
        ]}
        value={mode}
        data-testid="c4expr-mode"
        onChange={(v) => onMode(v as ExprMode)}
      />
      {mode === "text" ? (
        <ExprTextField seedText={seedText} onCommit={onCommit} />
      ) : (
        <ExprScopeContext.Provider value={candidates}>
          <MemberCandidatesContext.Provider value={memberMap}>
            <ArgLabelsContext.Provider value={argLabels}>
              <ExpressionEditor node={local} path="" onChange={handle} />
              {error && <Text size="xs" c="red">invalid expression</Text>}
            </ArgLabelsContext.Provider>
          </MemberCandidatesContext.Provider>
        </ExprScopeContext.Provider>
      )}
    </Box>
  );
}
