import { useState } from "react";
import { Box, Group, SegmentedControl, Select, Text, TextInput, Textarea } from "@mantine/core";
import { BINARY_OPS, UNARY_OPS, emitExpr, type EExpr } from "./expr-model";

export type ExprMode = "structured" | "text";

// Recursive structured expression editor. Operator nodes (binary/unary/paren)
// render dropdowns + nested operands; literals render typed inputs; everything
// else is a `raw` text leaf. `onChange(next, commit)` bubbles the full updated
// subtree up: live edits pass commit=false; discrete changes (operator/bool
// select) and text-leaf blur pass commit=true so the surface splices + re-parses.

interface NodeProps {
  node: EExpr;
  onChange: (next: EExpr, commit: boolean) => void;
}

export function ExpressionEditor({ node, onChange }: NodeProps): JSX.Element {
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
    case "raw":
      return (
        <TextInput
          size="xs"
          w={150}
          value={node.text}
          data-testid="c4expr-raw"
          styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
          onChange={(e) => onChange({ ...node, text: e.currentTarget.value }, false)}
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
  mode,
  onMode,
  onCommit,
}: {
  seed: EExpr;
  seedText: string;
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
        <>
          <ExpressionEditor node={local} onChange={handle} />
          {error && <Text size="xs" c="red">invalid expression</Text>}
        </>
      )}
    </Box>
  );
}
