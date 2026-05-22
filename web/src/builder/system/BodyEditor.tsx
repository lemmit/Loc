import { useState } from "react";
import { Button, Group, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { ASSIGN_OPS } from "./expr-model";
import type { StmtView } from "./body";

// Validated statement-list editor, shared by operation and workflow bodies
// (both `Statement[]`).  An assignment row splits into a dedicated target / op /
// value (the target edits as its own control); every other statement is an
// editable text row.  Each edit is committed on blur; the parent splices +
// re-parses and returns whether it committed (a syntactically-invalid edit is
// rejected and flagged here).  Semantic errors surface in the Problems panel
// after a commit lands.
//
// (Single-expression bodies — `function … = <expr>`, derived props, invariants
// — and a statement's *value* expression are edited by the structured
// `ExpressionEditor`, not here.)

interface BodyEditorProps {
  statements: StmtView[];
  /** Returns true if the edit was committed (parsed); false → rejected. */
  onEdit: (index: number, text: string) => boolean;
  onDelete: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onAdd: (text: string) => boolean;
}

const MONO = { input: { fontFamily: "monospace", fontSize: 11 } };

function viewText(v: StmtView): string {
  if (v.kind === "assign") return `${v.target} ${v.op} ${v.value}`;
  if (v.kind === "call") return `${v.head}(${v.args.join(", ")})`;
  return v.src;
}

// Bare-call row: a call head (`recv.method`) plus one editable input per
// argument, with add / delete. Reconstructs `head(a, b, …)` (empty args
// dropped). Args are controlled so add / delete stay correct.
function CallRow({ view, error, onCommit, onClearError }: {
  view: { head: string; args: string[] };
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [head, setHead] = useState(view.head);
  const [args, setArgs] = useState<string[]>(view.args);
  const reconstruct = (h: string, a: string[]): string =>
    `${h.trim()}(${a.map((x) => x.trim()).filter((x) => x !== "").join(", ")})`;
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <TextInput
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          defaultValue={head}
          error={error ? "invalid" : undefined}
          data-testid="c4system-call-head"
          aria-label="call target"
          styles={MONO}
          onFocus={onClearError}
          onChange={(e) => setHead(e.currentTarget.value)}
          onBlur={() => onCommit(reconstruct(head, args))}
        />
        <Button size="compact-xs" variant="subtle" data-testid="c4system-call-arg-add" onClick={() => setArgs((p) => [...p, ""])}>
          + arg
        </Button>
      </Group>
      {args.map((arg, i) => (
        <Group key={i} gap={4} wrap="nowrap" align="center" style={{ paddingLeft: 12 }}>
          <TextInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            value={arg}
            data-testid="c4system-call-arg"
            aria-label={`argument ${i + 1}`}
            styles={MONO}
            onFocus={onClearError}
            onChange={(e) => setArgs((prev) => prev.map((x, j) => (j === i ? e.currentTarget.value : x)))}
            onBlur={() => onCommit(reconstruct(head, args))}
          />
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            data-testid="c4system-call-arg-del"
            onClick={() => {
              const next = args.filter((_, j) => j !== i);
              setArgs(next);
              onCommit(reconstruct(head, next));
            }}
          >
            ×
          </Button>
        </Group>
      ))}
    </Stack>
  );
}

// Assignment row: target / op / value as separate controls. Local draft state so
// any field can change before the reconstructed statement is committed on blur
// (or immediately on an op change).
function AssignRow({ view, error, onCommit, onClearError }: {
  view: { target: string; op: string; value: string };
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [target, setTarget] = useState(view.target);
  const [op, setOp] = useState(view.op);
  const [value, setValue] = useState(view.value);
  const reconstruct = (t: string, o: string, v: string): string => `${t.trim()} ${o} ${v.trim()}`;
  return (
    <>
      <TextInput
        size="xs"
        w={96}
        defaultValue={target}
        data-testid="c4system-stmt-target"
        aria-label="assignment target"
        styles={MONO}
        onFocus={onClearError}
        onChange={(e) => setTarget(e.currentTarget.value)}
        onBlur={() => onCommit(reconstruct(target, op, value))}
      />
      <Select
        size="xs"
        w={64}
        data={ASSIGN_OPS}
        value={op}
        allowDeselect={false}
        data-testid="c4system-stmt-op"
        onChange={(o) => { if (o) { setOp(o); onCommit(reconstruct(target, o, value)); } }}
      />
      <Textarea
        size="xs"
        autosize
        minRows={1}
        style={{ flex: 1, minWidth: 0 }}
        defaultValue={value}
        error={error ? "invalid" : undefined}
        data-testid="c4system-stmt-value"
        styles={MONO}
        onFocus={onClearError}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(reconstruct(target, op, value))}
      />
    </>
  );
}

export function BodyEditor({ statements, onEdit, onDelete, onMove, onAdd }: BodyEditorProps): JSX.Element {
  const [errorAt, setErrorAt] = useState<number | null>(null);
  const [draftAdd, setDraftAdd] = useState("");
  const [addError, setAddError] = useState(false);

  const commitEdit = (index: number, original: string, value: string): void => {
    if (value.trim() === original.trim()) {
      setErrorAt(null);
      return;
    }
    // On success the parent re-seeds (remount) — only flag failures here.
    if (!onEdit(index, value)) setErrorAt(index);
  };

  const commitAdd = (): void => {
    if (!draftAdd.trim()) return;
    if (onAdd(draftAdd)) {
      setDraftAdd("");
      setAddError(false);
    } else {
      setAddError(true);
    }
  };

  return (
    <Stack gap={4} data-testid="c4system-body">
      <Text size="xs" tt="uppercase" c="dimmed">Body</Text>
      {statements.length === 0 && <Text size="xs" c="dimmed">No statements.</Text>}
      {statements.map((s, i) => {
        const original = viewText(s);
        return (
          <Group key={`${i}-${original}`} gap={4} align="flex-start" wrap="nowrap" data-testid="c4system-stmt-row">
            {s.kind === "assign" ? (
              <AssignRow
                view={s}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, original, text)}
              />
            ) : s.kind === "call" ? (
              <CallRow
                view={s}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, original, text)}
              />
            ) : (
              <Textarea
                size="xs"
                autosize
                minRows={1}
                style={{ flex: 1, minWidth: 0 }}
                defaultValue={s.src}
                error={errorAt === i ? "invalid" : undefined}
                data-testid="c4system-stmt"
                styles={MONO}
                onFocus={() => errorAt === i && setErrorAt(null)}
                onBlur={(e) => commitEdit(i, s.src, e.currentTarget.value)}
              />
            )}
            <Button size="compact-xs" variant="subtle" data-testid="c4system-stmt-up" disabled={i === 0} onClick={() => onMove(i, -1)}>
              ↑
            </Button>
            <Button size="compact-xs" variant="subtle" data-testid="c4system-stmt-down" disabled={i === statements.length - 1} onClick={() => onMove(i, 1)}>
              ↓
            </Button>
            <Button size="compact-xs" variant="subtle" color="red" data-testid="c4system-stmt-delete" onClick={() => onDelete(i)}>
              ×
            </Button>
          </Group>
        );
      })}
      <Group gap={4} align="flex-start" wrap="nowrap">
        <Textarea
          size="xs"
          autosize
          minRows={1}
          style={{ flex: 1, minWidth: 0 }}
          placeholder="add a statement…"
          value={draftAdd}
          error={addError ? "invalid" : undefined}
          data-testid="c4system-stmt-add-input"
          styles={MONO}
          onChange={(e) => {
            setDraftAdd(e.currentTarget.value);
            if (addError) setAddError(false);
          }}
        />
        <Button size="compact-xs" variant="light" data-testid="c4system-stmt-add" disabled={!draftAdd.trim()} onClick={commitAdd}>
          +
        </Button>
      </Group>
    </Stack>
  );
}
