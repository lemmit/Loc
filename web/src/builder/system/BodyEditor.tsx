import { useState } from "react";
import { Button, Group, Stack, Text, Textarea } from "@mantine/core";

// Validated-text statement-list editor, shared by operation and workflow bodies
// (both `Statement[]`).  Each statement is an editable text row committed on
// blur; the parent splices + re-parses and returns whether it committed (a
// syntactically-invalid edit is rejected and flagged here).  Semantic errors
// surface in the Problems panel after a commit lands.
//
// (Single-expression bodies — `function … = <expr>`, derived props, invariants
// — are edited by the structured `ExpressionEditor`, not here.)

interface BodyEditorProps {
  statements: string[];
  /** Returns true if the edit was committed (parsed); false → rejected. */
  onEdit: (index: number, text: string) => boolean;
  onDelete: (index: number) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onAdd: (text: string) => boolean;
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
      {statements.map((s, i) => (
        <Group key={`${i}-${s}`} gap={4} align="flex-start" wrap="nowrap" data-testid="c4system-stmt-row">
          <Textarea
            size="xs"
            autosize
            minRows={1}
            style={{ flex: 1, minWidth: 0 }}
            defaultValue={s}
            error={errorAt === i ? "invalid" : undefined}
            data-testid="c4system-stmt"
            styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
            onFocus={() => errorAt === i && setErrorAt(null)}
            onBlur={(e) => commitEdit(i, s, e.currentTarget.value)}
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
      ))}
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
          styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
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
