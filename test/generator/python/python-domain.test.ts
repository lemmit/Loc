import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — domain primitives emission (plan S3): NewType ids,
// StrEnum enums, value-object classes with constructor invariants /
// @property derived / public functions, frozen-dataclass events with
// the DomainEvent union + dispatcher boundary, and the error taxonomy.
// ---------------------------------------------------------------------------

const FIXTURE = `system PyDomain {
  subdomain Ops {
    context Ops {
      enum WidgetStatus { Draft, Active, Retired }

      valueobject Price {
        amount: decimal
        currency: string
        invariant amount >= 0
        invariant currency.length == 3
        derived shortLabel: string = currency + " " + string(amount)
        function doubled(): decimal = amount * 2
      }

      event WidgetActivated {
        widget: Widget id,
        at: datetime
      }

      aggregate Widget {
        label: string
        status: WidgetStatus
        price: Price
        contains notes: WidgetNote[]
        operation activate() {
          precondition status == Draft
          status := Active
          emit WidgetActivated { widget: id, at: now() }
        }
        entity WidgetNote {
          text: string
        }
      }
      repository Widgets for Widget { }
    }
  }

  api OpsApi from Ops

  storage pg { type: postgres }
  resource opsState { for: Ops, kind: state, use: pg }

  deployable api {
    platform: python
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 8000
  }
}
`;

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python domain primitives", () => {
  it("ids.py brands one NewType + uuid7 factory per aggregate and part", async () => {
    const files = await build();
    const ids = files.get("api/app/domain/ids.py")!;
    expect(ids).toContain('WidgetId = NewType("WidgetId", str)');
    expect(ids).toContain('WidgetNoteId = NewType("WidgetNoteId", str)');
    expect(ids).toContain("def new_widget_id() -> WidgetId:");
    expect(ids).toContain("def new_widget_note_id() -> WidgetNoteId:");
    expect(ids).toContain("from uuid6 import uuid7");
    expect(ids).toContain("return WidgetId(str(uuid7()))");
  });

  it("errors.py carries the three-status error taxonomy", async () => {
    const files = await build();
    const errors = files.get("api/app/domain/errors.py")!;
    expect(errors).toContain("class DomainError(Exception):");
    expect(errors).toContain("class AggregateNotFoundError(Exception):");
    expect(errors).toContain("class ForbiddenError(Exception):");
  });

  it("enums render as StrEnum with member name == wire value", async () => {
    const files = await build();
    const vos = files.get("api/app/domain/value_objects.py")!;
    expect(vos).toContain("class WidgetStatus(StrEnum):");
    expect(vos).toContain('    Draft = "Draft"');
    expect(vos).toContain('    Retired = "Retired"');
  });

  it("value objects are frozen dataclasses with __post_init__ invariants (S9)", async () => {
    const files = await build();
    const vos = files.get("api/app/domain/value_objects.py")!;
    // frozen=True gives field-wise __eq__/__hash__ (value semantics — the
    // defining VO property) and rejects post-construction mutation; the
    // dataclass __init__ keeps the declaration-order signature, so every
    // construction site is unchanged.
    expect(vos).toContain("from dataclasses import dataclass");
    expect(vos).toContain("@dataclass(frozen=True)");
    expect(vos).toContain("class Price:");
    expect(vos).toContain("    amount: float");
    expect(vos).toContain("    currency: str");
    expect(vos).toContain("    def __post_init__(self) -> None:");
    expect(vos).toContain("        if not (self.amount >= 0):");
    expect(vos).toContain('            raise DomainError("Invariant violated: amount >= 0")');
    expect(vos).toContain("        if not (len(self.currency) == 3):");
  });

  it("VO derived render as @property, functions as public methods", async () => {
    const files = await build();
    const vos = files.get("api/app/domain/value_objects.py")!;
    expect(vos).toContain("    @property");
    expect(vos).toContain("    def short_label(self) -> str:");
    expect(vos).toContain('        return self.currency + " " + str(self.amount)');
    // Public (no underscore): VO functions are cross-boundary surface.
    expect(vos).toContain("    def doubled(self) -> float:");
    expect(vos).toContain("        return self.amount * 2");
  });

  it("events render as frozen dataclasses with a ClassVar wire tag", async () => {
    const files = await build();
    const events = files.get("api/app/domain/events.py")!;
    expect(events).toContain("@dataclass(frozen=True)");
    expect(events).toContain("class WidgetActivated:");
    expect(events).toContain('    type: ClassVar[str] = "WidgetActivated"');
    expect(events).toContain("    widget: WidgetId");
    expect(events).toContain("    at: datetime");
    expect(events).toContain("from app.domain.ids import WidgetId");
  });

  it("events module exposes the DomainEvent alias + dispatcher boundary", async () => {
    const files = await build();
    const events = files.get("api/app/domain/events.py")!;
    expect(events).toContain("DomainEvent = WidgetActivated");
    expect(events).toContain("class DomainEventDispatcher(Protocol):");
    expect(events).toContain("    async def dispatch(self, event: DomainEvent) -> None: ...");
    expect(events).toContain("class NoopDomainEventDispatcher:");
  });

  it("an event-less context degrades DomainEvent to Never", async () => {
    const { model, errors } = await parseString(
      FIXTURE.replace(/event WidgetActivated \{[\s\S]*?\}\n/, "").replace(
        /\s*emit WidgetActivated \{ widget: id, at: now\(\) \}/,
        "",
      ),
    );
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const events = files.get("api/app/domain/events.py")!;
    expect(events).toContain("DomainEvent = Never");
    expect(events).toContain("from typing import Never, Protocol");
  });
});
