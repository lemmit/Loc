// Optional fields must not emit a null dereference — Angular + Svelte.
//
// M-FT.22 / finding S9.  `Budget?` ships `budget: null` on the wire, so the
// scaffolded detail page's flattened leaf row (`p.budget.amount`) throws at
// runtime on every record without one.  React and Vue bundle it green because
// their build never type-checks a page; the two frontends that DO type-check
// theirs fail outright — `ng build` with TS2531 "Object is possibly 'null'",
// svelte-check with "'projectById.data.budget' is possibly 'null' or
// 'undefined'".  Same shape for a `File?`: Angular's `fieldInput` matched on
// the RAW field type, so an optional File missed the File arm (and its
// `FileRef` / `api` / `AbstractControl` imports) while the control it emitted
// was still typed `FormControl<FileRef | null>` — TS2304 twice.
//
// This is the FAST guard.  The full proof is the build tier
// (`LOOM_ANGULAR_BUILD_CASE=optional:…`, `LOOM_SVELTE_BUILD_CASE=…
// optional-fields.ddd:…`), which runs the real type-checkers; these assertions
// are what fail in seconds when a refactor drops the guard.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SOURCE = (platform: "angular" | "svelte", design: string) => `
  system OptFields {
    subdomain Core {
      context Tracking {
        valueobject Budget {
          amount: decimal
          currency: string
        }
        aggregate Project with crudish {
          name: string
          note: string?
          budget: Budget?
          attachment: File?
          derived display: string = name
          operation fund(amount: decimal, currency: string) {
            budget := Budget { amount: amount, currency: currency }
          }
        }
      }
    }
    api TrackingApi from Core
    ui WebApp with scaffold(subdomains: [Core]) {
      api Tracking: TrackingApi
    }
    storage primary { type: postgres }
    storage blobs { type: localDisk }
    resource trackingState { for: Tracking, kind: state, use: primary }
    resource trackingFiles { for: Tracking, kind: objectStore, use: blobs }
    deployable api {
      platform: node
      contexts: [Tracking]
      dataSources: [trackingState, trackingFiles]
      serves: TrackingApi
      port: 3000
    }
    deployable web {
      platform: ${platform}
      targets: api
      ui: WebApp { Tracking: api }
      port: 3004
      design: ${design}
    }
  }
`;

describe.each([
  "angularMaterial",
  "primeng",
  "spartanNg",
])("angular optional fields — %s", (design) => {
  const files = () => generateSystemFiles(SOURCE("angular", design));

  it("null-chains an optional value object's leaf reads on the detail page", async () => {
    const detail = (await files()).get("web/src/app/pages/project-detail.component.ts")!;
    expect(detail).toContain("budget?.amount");
    expect(detail).toContain("budget?.currency");
    // The unguarded form is the TS2531 that failed `ng build`.
    expect(detail).not.toMatch(/budget\.(amount|currency)/);
  });

  it("leaves a REQUIRED member read verbatim", async () => {
    const detail = (await files()).get("web/src/app/pages/project-detail.component.ts")!;
    expect(detail).toContain(".data()!.name");
    expect(detail).not.toContain(".data()!?.name");
  });

  it("types a File RESPONSE field as the client's FileRef, not `unknown`", async () => {
    const api = (await files()).get("web/src/api/project.ts")!;
    expect(api).toContain('import type { FileRef } from "./client";');
    expect(api).toContain("attachment: FileRef | null;");
    // Request-side stays `unknown`: the control is `FormControl<FileRef | null>`
    // and `getRawValue()` has to stay assignable for a REQUIRED File too.
    expect(api).toContain("attachment: unknown | null;");
  });

  it("null-chains FileLink's ref reads (Angular narrows no chain off a call)", async () => {
    const detail = (await files()).get("web/src/app/pages/project-detail.component.ts")!;
    expect(detail).toContain("attachment?.url");
    expect(detail).toContain("attachment?.key");
  });

  it("renders an optional File as a file input and imports what it needs", async () => {
    const create = (await files()).get("web/src/app/pages/project-new.component.ts")!;
    expect(create).toContain("attachment: new FormControl<FileRef | null>(null)");
    // Both names the control + its upload handler reference.
    expect(create).toMatch(/import \{[^}]*\bFileRef\b[^}]*\} from "\.\.\/\.\.\/api\/client"/);
    expect(create).toMatch(/import \{[^}]*\bapi\b[^}]*\} from "\.\.\/\.\.\/api\/client"/);
    expect(create).toMatch(/import \{[^}]*\bAbstractControl\b[^}]*\} from "@angular\/forms"/);
    expect(create).toContain('<input type="file"');
  });
});

describe.each(["shadcnSvelte", "flowbite"])("svelte optional fields — %s", (design) => {
  const files = () => generateSystemFiles(SOURCE("svelte", design));

  it("null-chains an optional value object's leaf reads on the detail page", async () => {
    const detail = (await files()).get("web/src/routes/(app)/projects/[id]/+page.svelte")!;
    expect(detail).toContain("budget?.amount");
    expect(detail).not.toMatch(/data\.budget\.(amount|currency)/);
  });

  it("types a form's bound values off what it SEEDS, not the wire's optionality", async () => {
    const forms = (await files()).get("web/src/lib/forms.svelte.ts")!;
    // `values` is the stripped shape; the schema type still governs `submit`.
    expect(forms).toContain("export type FormValues<T>");
    expect(forms).toContain("values: FormValues<T>;");
    expect(forms).toContain("submit(onValid: (vals: T) => Promise<void> | void)");
    // A File field is the one member that stays nullable — "nothing uploaded
    // yet" is a real state the form seeds as `null`.
    expect(forms).toContain("FileRefValue");
  });
});
