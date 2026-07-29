import { useState, type ReactNode } from "react";
import { Autocomplete, Box, Button, Group, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { ASSIGN_OPS } from "./expr-model";
import {
  insertIntoList,
  insertMatchArm,
  removeSpan,
  replaceSpan,
  stmtText,
  swapSpans,
  type StmtListView,
  type StmtView,
} from "./body";

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
export function EmitRow({ view, error, onCommit, onClearError, renderFieldEditor, onToggleField, events, onRepointEvent }: {
  view: { event: string; fields: { name: string; value: string }[] };
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
  renderFieldEditor?: (fieldIndex: number) => ReactNode;
  onToggleField?: (fieldIndex: number) => void;
  /** Candidates for the event-name Select (the playground's event declarations).
   *  Provide together with `onRepointEvent` to make the event re-pointable
   *  inline; without these the event renders as a dimmed label. */
  events?: string[];
  onRepointEvent?: (eventName: string) => void;
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
        {events && onRepointEvent ? (
          <Group gap={4} wrap="nowrap" align="center">
            <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>emit</Text>
            <Select
              size="xs"
              w={170}
              data={events}
              value={view.event}
              allowDeselect={false}
              data-testid="c4system-emit-event"
              styles={MONO}
              onChange={(v) => { if (v) onRepointEvent(v); }}
            />
          </Group>
        ) : (
          <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>emit {view.event}</Text>
        )}
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

// Single-expression keyword rows — `let n = <expr>`, `return <expr>`,
// `requires <expr>`, `precondition <expr> message "…"`.  Each reconstructs the
// whole statement from its parts (all of them verbatim source text, so nothing
// is reformatted), and offers the same `ƒx` swap to the structured editor the
// assignment row does — there it edits just the expression, leaving the
// keyword and the `let` binding's name untouched.
export function SimpleStmtRow({ view, valueEditor, onToggleEditor, error, onCommit, onClearError }: {
  view: Extract<StmtView, { kind: "let" | "return" | "precondition" | "requires" }>;
  valueEditor: ReactNode;
  onToggleEditor?: () => void;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [name, setName] = useState(view.kind === "let" ? view.name : "");
  const [expr, setExpr] = useState(view.kind === "let" || view.kind === "return" ? view.value : view.expr);
  const [message, setMessage] = useState(view.kind === "precondition" ? (view.message ?? "") : "");
  const structured = valueEditor != null;
  const keyword = view.kind;
  const reconstruct = (n: string, e: string, m: string): string => {
    if (view.kind === "let") return `let ${n.trim()} = ${e.trim()}`;
    if (view.kind === "return") return `return ${e.trim()}`;
    if (view.kind === "requires") return `requires ${e.trim()}`;
    return `precondition ${e.trim()}${m.trim() ? ` message ${JSON.stringify(m.trim())}` : ""}`;
  };
  const commit = (): void => onCommit(reconstruct(name, expr, message));
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", paddingTop: 4 }}>{keyword}</Text>
        {view.kind === "let" && (
          <TextInput
            size="xs"
            w={96}
            value={name}
            data-testid="c4system-stmt-let-name"
            aria-label="let binding name"
            styles={MONO}
            onFocus={onClearError}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={commit}
          />
        )}
        {!structured && (
          <Textarea
            size="xs"
            autosize
            minRows={1}
            style={{ flex: 1, minWidth: 0 }}
            value={expr}
            error={error ? "invalid" : undefined}
            data-testid="c4system-stmt"
            aria-label={`${keyword} expression`}
            styles={MONO}
            onFocus={onClearError}
            onChange={(e) => setExpr(e.currentTarget.value)}
            onBlur={commit}
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
      {view.kind === "precondition" && (
        <Group gap={4} wrap="nowrap" align="center" style={{ paddingLeft: 12 }}>
          <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>message</Text>
          <TextInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            value={message}
            placeholder="(none)"
            data-testid="c4system-stmt-message"
            aria-label="precondition message"
            styles={MONO}
            onFocus={onClearError}
            onChange={(e) => setMessage(e.currentTarget.value)}
            onBlur={commit}
          />
        </Group>
      )}
    </Stack>
  );
}

// A nested statement list (a loop body, an `if let` branch, a match arm) —
// the SAME per-statement rows as the top level, recursively.  Every mutation is
// a span splice over the ENCLOSING statement's source: the row hands the parent
// the rewritten statement text, which the parent commits as one CST splice, so
// the untouched parts of the block (comments, spacing, sibling statements)
// travel through byte-for-byte.
function NestedList({ label, src, list, onSrc, error, onClearError }: {
  label: string;
  src: string;
  list: StmtListView;
  onSrc: (next: string) => void;
  error: boolean;
  onClearError: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  return (
    <Stack gap={2} style={{ paddingLeft: 12, borderLeft: "1px solid var(--mantine-color-dark-4)" }} data-testid="c4system-stmt-nested">
      <Text size="xs" tt="uppercase" c="dimmed">{label}</Text>
      {list.items.length === 0 && <Text size="xs" c="dimmed">empty</Text>}
      {list.items.map((child, i) => (
        <Group key={`${i}-${stmtText(child)}`} gap={4} align="flex-start" wrap="nowrap" data-testid="c4system-stmt-nested-row">
          <StmtRow
            view={child}
            error={false}
            onClearError={onClearError}
            onCommit={(t) => onSrc(replaceSpan(src, list.spans[i]!, t))}
          />
          <Button size="compact-xs" variant="subtle" data-testid="c4system-stmt-nested-up" disabled={i === 0}
            onClick={() => onSrc(swapSpans(src, list.spans[i]!, list.spans[i - 1]!))}>
            ↑
          </Button>
          <Button size="compact-xs" variant="subtle" data-testid="c4system-stmt-nested-down" disabled={i === list.items.length - 1}
            onClick={() => onSrc(swapSpans(src, list.spans[i]!, list.spans[i + 1]!))}>
            ↓
          </Button>
          <Button size="compact-xs" variant="subtle" color="red" data-testid="c4system-stmt-nested-delete"
            onClick={() => onSrc(removeSpan(src, list.spans[i]!))}>
            ×
          </Button>
        </Group>
      ))}
      <Group gap={4} wrap="nowrap" align="flex-start">
        <TextInput
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="add a statement…"
          value={draft}
          error={error ? "invalid" : undefined}
          data-testid="c4system-stmt-nested-add-input"
          styles={MONO}
          onFocus={onClearError}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <Button size="compact-xs" variant="light" data-testid="c4system-stmt-nested-add" disabled={!draft.trim()}
          onClick={() => onSrc(insertIntoList(src, list, draft))}>
          +
        </Button>
      </Group>
    </Stack>
  );
}

// `for <binder> in <iterable> { … }` — header inputs over a nested body list.
export function ForRow({ view, error, onCommit, onClearError }: {
  view: Extract<StmtView, { kind: "for" }>;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [binder, setBinder] = useState(view.binder);
  const [iterable, setIterable] = useState(view.iterable);
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>for</Text>
        <TextInput size="xs" w={84} value={binder} data-testid="c4system-stmt-for-binder" aria-label="loop binder"
          styles={MONO} onFocus={onClearError} onChange={(e) => setBinder(e.currentTarget.value)}
          onBlur={() => onCommit(replaceSpan(view.src, view.binderAt, binder.trim()))} />
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>in</Text>
        <TextInput size="xs" style={{ flex: 1, minWidth: 0 }} value={iterable} error={error ? "invalid" : undefined}
          data-testid="c4system-stmt-for-iterable" aria-label="loop iterable" styles={MONO}
          onFocus={onClearError} onChange={(e) => setIterable(e.currentTarget.value)}
          onBlur={() => onCommit(replaceSpan(view.src, view.iterableAt, iterable.trim()))} />
      </Group>
      <NestedList label="body" src={view.src} list={view.body} onSrc={onCommit} error={error} onClearError={onClearError} />
    </Stack>
  );
}

// `if let <binder> = <subject> { … } else { … }`.
export function IfLetRow({ view, error, onCommit, onClearError }: {
  view: Extract<StmtView, { kind: "ifLet" }>;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [binder, setBinder] = useState(view.binder);
  const [subject, setSubject] = useState(view.subject);
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>if let</Text>
        <TextInput size="xs" w={84} value={binder} data-testid="c4system-stmt-iflet-binder" aria-label="if-let binder"
          styles={MONO} onFocus={onClearError} onChange={(e) => setBinder(e.currentTarget.value)}
          onBlur={() => onCommit(replaceSpan(view.src, view.binderAt, binder.trim()))} />
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>=</Text>
        <TextInput size="xs" style={{ flex: 1, minWidth: 0 }} value={subject} error={error ? "invalid" : undefined}
          data-testid="c4system-stmt-iflet-subject" aria-label="if-let subject" styles={MONO}
          onFocus={onClearError} onChange={(e) => setSubject(e.currentTarget.value)}
          onBlur={() => onCommit(replaceSpan(view.src, view.subjectAt, subject.trim()))} />
      </Group>
      <NestedList label="then" src={view.src} list={view.then} onSrc={onCommit} error={error} onClearError={onClearError} />
      {view.else && (
        <NestedList label="else" src={view.src} list={view.else} onSrc={onCommit} error={error} onClearError={onClearError} />
      )}
    </Stack>
  );
}

// The effect-form `match <subject> { Variant b => { … } … else => { … } }`.
// Arm variant names are free text validated by the parent's re-parse (a full
// payload-type-aware picker is a later slice).
export function MatchRow({ view, error, onCommit, onClearError }: {
  view: Extract<StmtView, { kind: "match" }>;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
}): JSX.Element {
  const [subject, setSubject] = useState(view.subject);
  const [newArm, setNewArm] = useState("");
  return (
    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>match</Text>
        <TextInput size="xs" style={{ flex: 1, minWidth: 0 }} value={subject} error={error ? "invalid" : undefined}
          data-testid="c4system-stmt-match-subject" aria-label="match subject" styles={MONO}
          onFocus={onClearError} onChange={(e) => setSubject(e.currentTarget.value)}
          onBlur={() => onCommit(replaceSpan(view.src, view.subjectAt, subject.trim()))} />
      </Group>
      {view.arms.map((arm, i) => (
        <Stack key={`${i}-${arm.variant}`} gap={2} style={{ paddingLeft: 8 }} data-testid="c4system-stmt-match-arm">
          <Group gap={4} wrap="nowrap" align="center">
            <TextInput size="xs" w={130} defaultValue={arm.variant} data-testid="c4system-stmt-match-variant"
              aria-label={`arm ${i + 1} variant`} styles={MONO} onFocus={onClearError}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== arm.variant) onCommit(replaceSpan(view.src, arm.variantAt, v));
              }} />
            <TextInput size="xs" w={84} defaultValue={arm.binder} placeholder="binder"
              data-testid="c4system-stmt-match-binder" aria-label={`arm ${i + 1} binder`} styles={MONO}
              onFocus={onClearError}
              onBlur={(e) => {
                const b = e.currentTarget.value.trim();
                if (b === arm.binder) return;
                // No binding declared yet → append one after the variant type.
                const span = arm.binderAt ?? { at: arm.variantAt.at + arm.variantAt.len, len: 0 };
                onCommit(replaceSpan(view.src, span, b ? (arm.binderAt ? b : ` ${b}`) : ""));
              }} />
            <Button size="compact-xs" variant="subtle" color="red" data-testid="c4system-stmt-match-arm-del"
              onClick={() => onCommit(removeSpan(view.src, view.armSpans[i]!))}>
              ×
            </Button>
          </Group>
          <NestedList label="=>" src={view.src} list={arm.body} onSrc={onCommit} error={error} onClearError={onClearError} />
        </Stack>
      ))}
      {view.else && (
        <NestedList label="else" src={view.src} list={view.else} onSrc={onCommit} error={error} onClearError={onClearError} />
      )}
      <Group gap={4} wrap="nowrap" align="center">
        <TextInput size="xs" w={130} value={newArm} placeholder="Variant…" data-testid="c4system-stmt-match-arm-new"
          aria-label="new arm variant" styles={MONO} onFocus={onClearError}
          onChange={(e) => setNewArm(e.currentTarget.value)} />
        <Button size="compact-xs" variant="light" data-testid="c4system-stmt-match-arm-add" disabled={!newArm.trim()}
          onClick={() => onCommit(insertMatchArm(view.src, view, newArm))}>
          + arm
        </Button>
      </Group>
    </Stack>
  );
}

interface StmtRowProps {
  view: StmtView;
  error: boolean;
  onCommit: (text: string) => void;
  onClearError: () => void;
  targets?: string[];
  headCandidates?: string[];
  valueEditor?: ReactNode;
  onToggleEditor?: () => void;
  renderArgEditor?: (argIndex: number) => ReactNode;
  onToggleArg?: (argIndex: number) => void;
  renderFieldEditor?: (fieldIndex: number) => ReactNode;
  onToggleField?: (fieldIndex: number) => void;
  events?: string[];
  onRepointEvent?: (eventName: string) => void;
}

/** One statement row, dispatched on the view's grammar form. Shared by the
 *  top-level body list, the v2 flow node, and nested container bodies. */
export function StmtRow(p: StmtRowProps): JSX.Element {
  const v = p.view;
  switch (v.kind) {
    case "assign":
      return (
        <AssignRow view={v} targets={p.targets ?? []} valueEditor={p.valueEditor ?? null}
          onToggleEditor={p.onToggleEditor} error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />
      );
    case "call":
      return (
        <CallRow view={v} headCandidates={p.headCandidates ?? []} error={p.error} onCommit={p.onCommit}
          onClearError={p.onClearError} renderArgEditor={p.renderArgEditor} onToggleArg={p.onToggleArg} />
      );
    case "emit":
      return (
        <EmitRow view={v} error={p.error} onCommit={p.onCommit} onClearError={p.onClearError}
          renderFieldEditor={p.renderFieldEditor} onToggleField={p.onToggleField}
          events={p.events} onRepointEvent={p.onRepointEvent} />
      );
    case "let":
    case "return":
    case "precondition":
    case "requires":
      return (
        <SimpleStmtRow view={v} valueEditor={p.valueEditor ?? null} onToggleEditor={p.onToggleEditor}
          error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />
      );
    case "for":
      return <ForRow view={v} error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />;
    case "ifLet":
      return <IfLetRow view={v} error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />;
    case "match":
      return <MatchRow view={v} error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />;
    default:
      return (
        <OtherRow src={v.src} valueEditor={p.valueEditor ?? null} onToggleEditor={p.onToggleEditor}
          error={p.error} onCommit={p.onCommit} onClearError={p.onClearError} />
      );
  }
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
        const original = stmtText(s);
        return (
          <Group key={`${i}-${original}`} gap={4} align="flex-start" wrap="nowrap" data-testid="c4system-stmt-row">
            <StmtRow
              view={s}
              targets={targets}
              headCandidates={headCandidates?.(i) ?? []}
              error={errorAt === i}
              onClearError={() => errorAt === i && setErrorAt(null)}
              onCommit={(text) => commitEdit(i, original, text)}
              valueEditor={renderValueEditor?.(i) ?? null}
              // The `ƒx` toggle only appears where the statement actually has a
              // single editable expression (`hasValueEditor`).
              onToggleEditor={
                onToggleValueEditor && hasValueEditor?.(i) !== false ? () => onToggleValueEditor(i) : undefined
              }
              renderArgEditor={(a) => (hasValueEditor?.(i, a) ? (renderValueEditor?.(i, a) ?? null) : null)}
              onToggleArg={onToggleValueEditor ? (a) => onToggleValueEditor(i, a) : undefined}
              renderFieldEditor={(f) => (hasValueEditor?.(i, f) ? (renderValueEditor?.(i, f) ?? null) : null)}
              onToggleField={onToggleValueEditor ? (f) => onToggleValueEditor(i, f) : undefined}
            />
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
