import { createContext, useContext, useState } from "react";
import { ActionIcon, Autocomplete, Box, Group, SegmentedControl, Select, Text, TextInput, Textarea } from "@mantine/core";
import { BINARY_OPS, UNARY_OPS, emitExpr, type ECallArg, type EExpr } from "./expr-model";

export type ExprMode = "structured" | "text";

// In-scope bare names for the expression being edited (params, properties,
// derived props, enum values…). Threaded to every `raw` leaf so they offer
// scope-aware suggestions while staying free-text.
const ExprScopeContext = createContext<string[]>([]);

// Recursive structured expression editor. Operator nodes (binary/unary/paren)
// render dropdowns + nested operands; literals render typed inputs; everything
// else is a `raw` text leaf. `onChange(next, commit)` bubbles the full updated
// subtree up: live edits pass commit=false; discrete changes (operator/bool
// select) and text-leaf blur pass commit=true so the surface splices + re-parses.

interface NodeProps {
  node: EExpr;
  onChange: (next: EExpr, commit: boolean) => void;
}

// Argument list shared by call (`f(…)`) and member-call (`a.b(…)`) nodes.
// Edits a single arg's value, removes an arg, or appends a positional one
// (defaulting to `null` so the result stays parseable until edited). Named args
// keep their name verbatim; renaming args is out of scope for now.
function ArgsEditor({ args, onArgs }: { args: ECallArg[]; onArgs: (args: ECallArg[], commit: boolean) => void }): JSX.Element {
  return (
    <Group gap={2} wrap="nowrap" align="center">
      <Text size="xs" c="dimmed">(</Text>
      {args.map((arg, i) => (
        <Group key={i} gap={2} wrap="nowrap" align="center">
          {i > 0 && <Text size="xs" c="dimmed">,</Text>}
          {arg.name && <Text size="xs" c="dimmed">{arg.name}:</Text>}
          <ExpressionEditor node={arg.value} onChange={(n, c) => onArgs(args.map((a, j) => (j === i ? { ...a, value: n } : a)), c)} />
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

export function ExpressionEditor({ node, onChange }: NodeProps): JSX.Element {
  const candidates = useContext(ExprScopeContext);
  switch (node.kind) {
    case "binary":
      return (
        <Group gap={4} wrap="nowrap" align="center" style={{ border: "1px solid var(--mantine-color-dark-4)", borderRadius: 4, padding: 2 }}>
          <ExpressionEditor node={node.left} onChange={(n, c) => onChange({ ...node, left: n }, c)} />
          <Select
            size="xs"
            w={64}
            data={BINARY_OPS}
            value={node.op}
            allowDeselect={false}
            data-testid="c4expr-op"
            onChange={(op) => op && onChange({ ...node, op }, true)}
          />
          <ExpressionEditor node={node.right} onChange={(n, c) => onChange({ ...node, right: n }, c)} />
        </Group>
      );
    case "unary":
      return (
        <Group gap={2} wrap="nowrap" align="center">
          <Select size="xs" w={48} data={UNARY_OPS} value={node.op} allowDeselect={false} onChange={(op) => op && onChange({ ...node, op }, true)} />
          <ExpressionEditor node={node.operand} onChange={(n, c) => onChange({ ...node, operand: n }, c)} />
        </Group>
      );
    case "paren":
      return (
        <Group gap={2} wrap="nowrap" align="center">
          <Text size="xs" c="dimmed">(</Text>
          <ExpressionEditor node={node.inner} onChange={(n, c) => onChange({ ...node, inner: n }, c)} />
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
          <ExpressionEditor node={node.callee} onChange={(n, c) => onChange({ ...node, callee: n }, c)} />
          <ArgsEditor args={node.args} onArgs={(args, c) => onChange({ ...node, args }, c)} />
        </Group>
      );
    case "member":
      return (
        <Group gap={1} wrap="nowrap" align="center">
          <ExpressionEditor node={node.receiver} onChange={(n, c) => onChange({ ...node, receiver: n }, c)} />
          <Text size="xs" c="dimmed">.</Text>
          <TextInput
            size="xs"
            w={90}
            value={node.member}
            data-testid="c4expr-member"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onChange={(e) => onChange({ ...node, member: e.currentTarget.value }, false)}
            onBlur={() => onChange(node, true)}
          />
          {node.call && <ArgsEditor args={node.args} onArgs={(args, c) => onChange({ ...node, args }, c)} />}
        </Group>
      );
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
  mode,
  onMode,
  onCommit,
}: {
  seed: EExpr;
  seedText: string;
  candidates: string[];
  mode: ExprMode;
  onMode: (mode: ExprMode) => void;
  onCommit: (text: string) => boolean;
}): JSX.Element {
  const [local, setLocal] = useState(seed);
  const [error, setError] = useState(false);
  const handle = (next: EExpr, commit: boolean): void => {
    setLocal(next);
    if (commit && !onCommit(emitExpr(next))) setError(true);
  };
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
          <ExpressionEditor node={local} onChange={handle} />
          {error && <Text size="xs" c="red">invalid expression</Text>}
        </ExprScopeContext.Provider>
      )}
    </Box>
  );
}
