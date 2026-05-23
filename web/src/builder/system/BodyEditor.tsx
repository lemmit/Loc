import { useState, type ReactNode } from "react";
import { Autocomplete, Box, Button, Group, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { ASSIGN_OPS } from "./expr-model";
import type { StmtView } from "./body";

// Validated statement-list editor, shared by operation and workflow bodies
// (both `Statement[]`).  An assignment row splits into a dedicated target / op /
// value (the target is an Autocomplete over the owner's assignable properties);
// every other statement is an editable text row.  Each edit is committed on
// blur; the parent splices + re-parses and returns whether it committed (a
// syntactically-invalid edit is rejected and flagged here).  Semantic errors
// surface in the Problems panel after a commit lands.
//
// (Single-expression bodies — `function … = <expr>`, derived props, invariants
// — and a statement's *value* expression are edited by the structured
// `ExpressionEditor`, not here.)

interface BodyEditorProps {
  statements: StmtView[];
  /** Assignable property names of the owner, for the target Autocomplete. */
  targets?: string[];
  /** Returns true if the edit was committed (parsed); false → rejected. */
  onEdit: (index: number, text: string) => boolean;
  onDelete: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onAdd: (text: string) => boolean;
  /** Whether statement `index` (optionally its `field`-th sub-expression) has an
   *  editable expression — i.e. should offer the inline structured `ƒx` editor. */
  hasValueEditor?: (index: number, field?: number) => boolean;
  /** In-scope names for a bare call's head (receiver) Autocomplete at `index`. */
  headCandidates?: (index: number) => string[];
  /** Inline structured editor for a statement's expression — rendered in place
   *  of the text field while that row is expanded; null when collapsed. */
  renderValueEditor?: (index: number, field?: number) => ReactNode;
  /** Toggle the inline structured editor for a statement's expression. */
  onToggleValueEditor?: (index: number, field?: number) => void;
}

const MONO = { input: { fontFamily: "monospace", fontSize: 11 } };

function viewText(v: StmtView): string {
  if (v.kind === "assign") return `${v.target} ${v.op} ${v.value}`;
  if (v.kind === "call") return `${v.head}(${v.args.join(", ")})`;
  if (v.kind === "emit") return `emit ${v.event} { ${v.fields.map((f) => `${f.name}: ${f.value}`).join(", ")} }`;
  return v.src;
}

// Bare-call row: a call head (`recv.method`) plus one editable input per
// argument, with add / delete. Reconstructs `head(a, b, …)` (empty args
// dropped). Args are controlled so add / delete stay correct. Each argument also
// offers a `ƒx` toggle that swaps its text field for the inline structured
// editor (which edits just that argument's expression).
export function CallRow({ view, headCandidates, error, onCommit, onClearError, renderArgEditor, onToggleArg }: {
  view: { head: string; args: string[] };
  headCandidates: string[];
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
  renderArgEditor?: (argIndex: number) => ReactNode;
  onToggleArg?: (argIndex: number) => void;
}): JSX.Element {
  const [head, setHead] = useState(view.head);
  const [args, setArgs] = useState<string[]>(view.args);
  const reconstruct = (h: string, a: string[]): string =>
    `${h.trim()}(${a.map((x) => x.trim()).filter((x) => x !== "").join(", ")})`;
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Autocomplete
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          data={headCandidates}
          defaultValue={head}
          error={error ? "invalid" : undefined}
          data-testid="c4system-call-head"
          aria-label="call target"
          styles={MONO}
          onFocus={onClearError}
          onChange={(v) => setHead(v)}
          onBlur={() => onCommit(reconstruct(head, args))}
        />
        <Button size="compact-xs" variant="subtle" data-testid="c4system-call-arg-add" onClick={() => setArgs((p) => [...p, ""])}>
          + arg
        </Button>
      </Group>
      {args.map((arg, i) => {
        const argEditor = renderArgEditor?.(i) ?? null;
        const structured = argEditor != null;
        return (
          <Group key={i} gap={4} wrap="nowrap" align="flex-start" style={{ paddingLeft: 12 }}>
            {structured ? (
              <Box style={{ flex: 1, minWidth: 0 }}>{argEditor}</Box>
            ) : (
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
            )}
            {onToggleArg && (
              <Button
                size="compact-xs"
                variant={structured ? "filled" : "subtle"}
                data-testid="c4system-call-arg-structured"
                title="edit the argument structurally"
                onClick={() => onToggleArg(i)}
              >
                ƒx
              </Button>
            )}
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
        );
      })}
    </Stack>
  );
}

// Assignment row: target / op / value as separate controls. Local draft state so
// any field can change before the reconstructed statement is committed on blur
// (or immediately on an op change). The value is a text field by default; the
// `ƒx` toggle swaps it for an inline structured expression editor (`valueEditor`),
// which commits the value independently — target/op reconstruct from the seeded
// value, kept fresh by the parent's re-seed-on-commit remount.
export function AssignRow({ view, targets, valueEditor, onToggleEditor, error, onCommit, onClearError }: {
  view: { target: string; op: string; value: string };
  targets: string[];
  valueEditor: ReactNode;
  onToggleEditor?: () => void;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [target, setTarget] = useState(view.target);
  const [op, setOp] = useState(view.op);
  const [value, setValue] = useState(view.value);
  const reconstruct = (t: string, o: string, v: string): string => `${t.trim()} ${o} ${v.trim()}`;
  const structured = valueEditor != null;
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Autocomplete
          size="xs"
          w={96}
          data={targets}
          defaultValue={target}
          data-testid="c4system-stmt-target"
          aria-label="assignment target"
          styles={MONO}
          onFocus={onClearError}
          onChange={(v) => setTarget(v)}
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
        {!structured && (
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
        )}
        {onToggleEditor && (
          <Button
            size="compact-xs"
            variant={structured ? "filled" : "subtle"}
            data-testid="c4system-stmt-structured"
            title="edit the value as a structured expression"
            onClick={onToggleEditor}
          >
            ƒx
          </Button>
        )}
      </Group>
      {structured && valueEditor}
    </Stack>
  );
}

// Emit row: the event (a label — repoint via the inspector's Emits picker) plus
// one `name: value` row per field, with add / delete. Each field value is a text
// input with a `ƒx` toggle to the inline structured editor (which edits just
// that field's value expression). Reconstructs `emit Event { a: x, b: y }`.
export function EmitRow({ view, error, onCommit, onClearError, renderFieldEditor, onToggleField }: {
  view: { event: string; fields: { name: string; value: string }[] };
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
  renderFieldEditor?: (fieldIndex: number) => ReactNode;
  onToggleField?: (fieldIndex: number) => void;
}): JSX.Element {
  const [fields, setFields] = useState(view.fields);
  const reconstruct = (fs: { name: string; value: string }[]): string => {
    const body = fs
      .filter((f) => f.name.trim() !== "" && f.value.trim() !== "")
      .map((f) => `${f.name.trim()}: ${f.value.trim()}`)
      .join(", ");
    return `emit ${view.event} {${body ? ` ${body} ` : ""}}`;
  };
  const setField = (i: number, patch: Partial<{ name: string; value: string }>): void =>
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>emit {view.event}</Text>
        <Button size="compact-xs" variant="subtle" data-testid="c4system-emit-field-add" onClick={() => setFields((p) => [...p, { name: "", value: "" }])}>
          + field
        </Button>
      </Group>
      {fields.map((f, i) => {
        const editor = renderFieldEditor?.(i) ?? null;
        const structured = editor != null;
        return (
          <Group key={i} gap={4} wrap="nowrap" align="flex-start" style={{ paddingLeft: 12 }}>
            <TextInput
              size="xs"
              w={84}
              value={f.name}
              data-testid="c4system-emit-field-name"
              aria-label={`field ${i + 1} name`}
              styles={MONO}
              onFocus={onClearError}
              onChange={(e) => setField(i, { name: e.currentTarget.value })}
              onBlur={() => onCommit(reconstruct(fields))}
            />
            <Text size="xs" c="dimmed" style={{ paddingTop: 4 }}>:</Text>
            {structured ? (
              <Box style={{ flex: 1, minWidth: 0 }}>{editor}</Box>
            ) : (
              <TextInput
                size="xs"
                style={{ flex: 1, minWidth: 0 }}
                value={f.value}
                error={error ? "invalid" : undefined}
                data-testid="c4system-emit-field-value"
                aria-label={`field ${i + 1} value`}
                styles={MONO}
                onFocus={onClearError}
                onChange={(e) => setField(i, { value: e.currentTarget.value })}
                onBlur={() => onCommit(reconstruct(fields))}
              />
            )}
            {onToggleField && (
              <Button
                size="compact-xs"
                variant={structured ? "filled" : "subtle"}
                data-testid="c4system-emit-field-structured"
                title="edit the field value structurally"
                onClick={() => onToggleField(i)}
              >
                ƒx
              </Button>
            )}
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              data-testid="c4system-emit-field-del"
              onClick={() => {
                const next = fields.filter((_, j) => j !== i);
                setFields(next);
                onCommit(reconstruct(next));
              }}
            >
              ×
            </Button>
          </Group>
        );
      })}
    </Stack>
  );
}

// A single-text statement row (precondition / requires / let / …). When the
// statement has an editable expression, the `ƒx` toggle swaps the text for the
// inline structured editor — which edits just the expression, leaving the
// keyword (and a `let` binding's name) untouched in source.
export function OtherRow({ src, valueEditor, onToggleEditor, error, onCommit, onClearError }: {
  src: string;
  valueEditor: ReactNode;
  onToggleEditor?: () => void;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const structured = valueEditor != null;
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        {structured ? (
          <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", paddingTop: 4 }}>
            {src.trimStart().split(/\s+/)[0]}
          </Text>
        ) : (
          <Textarea
            size="xs"
            autosize
            minRows={1}
            style={{ flex: 1, minWidth: 0 }}
            defaultValue={src}
            error={error ? "invalid" : undefined}
            data-testid="c4system-stmt"
            styles={MONO}
            onFocus={onClearError}
            onBlur={(e) => onCommit(e.currentTarget.value)}
          />
        )}
        {onToggleEditor && (
          <Button
            size="compact-xs"
            variant={structured ? "filled" : "subtle"}
            data-testid="c4system-stmt-structured"
            title="edit the expression structurally"
            onClick={onToggleEditor}
          >
            ƒx
          </Button>
        )}
      </Group>
      {structured && valueEditor}
    </Stack>
  );
}

export function BodyEditor({ statements, targets = [], onEdit, onDelete, onMove, onAdd, hasValueEditor, headCandidates, renderValueEditor, onToggleValueEditor }: BodyEditorProps): JSX.Element {
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
                targets={targets}
                valueEditor={renderValueEditor?.(i) ?? null}
                onToggleEditor={onToggleValueEditor ? () => onToggleValueEditor(i) : undefined}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, original, text)}
              />
            ) : s.kind === "call" ? (
              <CallRow
                view={s}
                headCandidates={headCandidates?.(i) ?? []}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, original, text)}
                renderArgEditor={(a) => (hasValueEditor?.(i, a) ? (renderValueEditor?.(i, a) ?? null) : null)}
                onToggleArg={onToggleValueEditor ? (a) => onToggleValueEditor(i, a) : undefined}
              />
            ) : s.kind === "emit" ? (
              <EmitRow
                view={s}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, original, text)}
                renderFieldEditor={(f) => (hasValueEditor?.(i, f) ? (renderValueEditor?.(i, f) ?? null) : null)}
                onToggleField={onToggleValueEditor ? (f) => onToggleValueEditor(i, f) : undefined}
              />
            ) : (
              <OtherRow
                src={s.src}
                valueEditor={hasValueEditor?.(i) ? (renderValueEditor?.(i) ?? null) : null}
                onToggleEditor={hasValueEditor?.(i) && onToggleValueEditor ? () => onToggleValueEditor(i) : undefined}
                error={errorAt === i}
                onClearError={() => errorAt === i && setErrorAt(null)}
                onCommit={(text) => commitEdit(i, s.src, text)}
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
