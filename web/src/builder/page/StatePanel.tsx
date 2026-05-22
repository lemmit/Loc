import { useState } from "react";
import { Button, Checkbox, Group, Popover, Select, Text, TextInput, UnstyledButton } from "@mantine/core";
import type { Page } from "../../../../src/language/generated/ast.js";
import { addStateField, deleteStateField, listStateFields, retypeStateField, setStateDefault, type StateFieldInfo } from "./state-fields";
import type { TypeOption, TypeSpec } from "../system/fields";

// A small "State (N)" popover in the page-builder toolbar that lists the
// selected page's `state {}` fields and lets you add / delete / retype / set a
// default.  Edits splice the source via `state-fields.ts`; rename is excluded
// (a state field's name is referenced in the body via IR lowering, not as a
// Langium cross-reference, so it can't be tracked).  Lives outside the craft
// `<Editor>` so it isn't remounted by the canvas re-seed.
interface Props {
  page: Page;
  getSource: () => string;
  types: TypeOption[];
  onApply: (next: string | null) => void;
}

export default function StatePanel({ page, getSource, types, onApply }: Props): JSX.Element {
  const fields = listStateFields(page);
  return (
    <Popover position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button size="compact-xs" variant="default" data-testid="c4state-toggle">State ({fields.length})</Button>
      </Popover.Target>
      <Popover.Dropdown p="xs" style={{ width: 380 }}>
        <Text size="xs" tt="uppercase" c="dimmed" mb={6}>Page state</Text>
        {fields.length === 0 && <Text size="xs" c="dimmed" mb="xs">No state fields.</Text>}
        {fields.map((f, i) => (
          <StateFieldRow key={`${i}:${f.name}`} field={f} index={i} pageName={page.name} getSource={getSource} types={types} onApply={onApply} />
        ))}
        <Button size="compact-xs" variant="light" mt={4} data-testid="c4state-add" onClick={() => onApply(addStateField(getSource(), page.name))}>
          + field
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
}

function StateFieldRow({ field, index, pageName, getSource, types, onApply }: {
  field: StateFieldInfo;
  index: number;
  pageName: string;
  getSource: () => string;
  types: TypeOption[];
  onApply: (next: string | null) => void;
}): JSX.Element {
  const [def, setDef] = useState(field.init ?? "");
  const retype = (spec: TypeSpec): void => onApply(retypeStateField(getSource(), pageName, index, spec));
  return (
    <Group gap={4} mb={4} wrap="nowrap" data-testid="c4state-field">
      <Text size="xs" style={{ width: 64, fontFamily: "monospace" }} truncate>{field.name}</Text>
      <Select
        size="xs"
        w={96}
        searchable
        data={types.map((t) => t.label)}
        value={field.baseLabel}
        data-testid="c4state-prop-type"
        onChange={(v) => { const opt = types.find((t) => t.label === v); if (opt) retype({ base: opt.base, array: field.array, optional: field.optional }); }}
      />
      <Checkbox size="xs" label="[]" checked={field.array} onChange={(e) => retype({ base: field.base, array: e.currentTarget.checked, optional: field.optional })} />
      <Checkbox size="xs" label="?" checked={field.optional} onChange={(e) => retype({ base: field.base, array: field.array, optional: e.currentTarget.checked })} />
      <TextInput
        size="xs"
        w={68}
        placeholder="default"
        value={def}
        data-testid="c4state-prop-default"
        onChange={(e) => setDef(e.currentTarget.value)}
        onBlur={() => { if (def !== (field.init ?? "")) onApply(setStateDefault(getSource(), pageName, index, def)); }}
      />
      <UnstyledButton data-testid="c4state-delete" onClick={() => onApply(deleteStateField(getSource(), pageName, index))} style={{ color: "var(--mantine-color-red-5)", fontSize: 12 }}>
        ✕
      </UnstyledButton>
    </Group>
  );
}
