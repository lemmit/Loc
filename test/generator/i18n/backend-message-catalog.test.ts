import { describe, expect, it } from "vitest";
import { messageCode } from "../../../src/util/message-code.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The BACKEND message catalog, on all five backends (M-T1.11).
//
// A messaged `invariant` / `check` / `precondition` already put a stable
// content-hash `code` on the 422 `errors[]`.  This slice adds the other half of
// "localise by code": each backend ships a CATALOG keyed by those same codes and
// resolves `errors[].message` through it for the request locale, so localisation
// no longer requires every client to carry a copy of every rule's text.
//
// Two invariants are asserted per backend:
//
//   1. the catalog exists, keyed by `messageCode(text)` — the SAME hash already
//      on the wire, so an existing client's `code` keeps resolving;
//   2. the backend's single 422 chokepoint RESOLVES through it (an emitted
//      catalog nothing reads is the dead-catalog class, gated on the UI side by
//      `user-visible-slot-coverage.test.ts`).
//
// Plus the byte-identical gate: a system with no authored message emits no
// catalog and no lookup anywhere.
// ---------------------------------------------------------------------------

const DOMAIN = `
      aggregate Product {
        sku: string check sku.length > 0 message "SKU is required"
        name: string
        qty: int
        invariant name.length >= 2 && name.length <= 120 message "Name must be 2-120 characters"
        invariant qty >= 0
        create(name: string, sku: string, qty: int) { }
        operation restock(amount: int) {
          precondition amount >= 1 message "Amount must be positive"
          qty := qty + amount
        }
      }
      repository Products for Product { }
`;

/** The same system on each backend, so the catalogs are directly comparable. */
const src = (platform: string, domain = DOMAIN) => `
  system S {
    subdomain Sales {
      context Cat {
${domain}
      }
    }
    api CatApi from Sales
    storage db { type: postgres }
    resource st { for: Cat, kind: state, use: db }
    deployable api { platform: ${platform} contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
  }
`;

/** A message-LESS twin of `DOMAIN` — the byte-identical baseline. */
const NO_MESSAGES = `
      aggregate Product {
        name: string
        qty: int
        invariant qty >= 0
        create(name: string, qty: int) { }
      }
      repository Products for Product { }
`;

const NAME_CODE = messageCode("Name must be 2-120 characters");
const SKU_CODE = messageCode("SKU is required");
const AMOUNT_CODE = messageCode("Amount must be positive");
const ALL_CODES = [AMOUNT_CODE, NAME_CODE, SKU_CODE].sort();

async function filesFor(platform: string, domain?: string): Promise<Map<string, string>> {
  return generateSystemFiles(src(platform, domain));
}

/** The catalog file for a backend, found by suffix (java/dotnet route files
 *  through a layout adapter, so an exact path would be layout-coupled). */
function bySuffix(files: Map<string, string>, suffix: string): string | undefined {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  return key ? files.get(key) : undefined;
}

describe("node/Hono — http/messages.ts + defaultHook resolution", () => {
  it("emits the catalog keyed by the wire codes", async () => {
    const catalog = bySuffix(await filesFor("node"), "http/messages.ts")!;
    expect(catalog).toBeDefined();
    for (const code of ALL_CODES) expect(catalog).toContain(`"${code}"`);
    expect(catalog).toContain(`"${NAME_CODE}": "Name must be 2-120 characters"`);
    // The lookup input is the AMBIENT request locale (D-CTX-SHAPE), not a new
    // plumbing axis.
    expect(catalog).toContain("requestContext()?.locale");
  });

  it("resolves errors[].message through the catalog in the 422 hook", async () => {
    const problem = bySuffix(await filesFor("node"), "http/problem-details.ts")!;
    expect(problem).toContain('import { localizeMessage } from "./messages"');
    expect(problem).toContain("message: localizeMessage(issue.params?.loomCode, issue.message)");
  });
});

describe(".NET — Localization/LoomMessages.cs + exception-filter resolution", () => {
  it("emits the catalog keyed by the wire codes", async () => {
    const catalog = bySuffix(await filesFor("dotnet"), "Localization/LoomMessages.cs")!;
    expect(catalog).toBeDefined();
    for (const code of ALL_CODES) expect(catalog).toContain(`["${code}"]`);
    expect(catalog).toContain(`["${NAME_CODE}"] = "Name must be 2-120 characters"`);
    expect(catalog).toContain("RequestContext.Current?.Locale");
  });

  it("resolves errors[].message through the catalog in the 422 arm", async () => {
    const filter = bySuffix(await filesFor("dotnet"), "Api/DomainExceptionFilter.cs")!;
    expect(filter).toContain("LoomMessages.Localize(e.ErrorCode, e.ErrorMessage)");
  });

  it("routes a messaged PRECONDITION onto the carrier with its text + code", async () => {
    // The op validator dropped `message` when lifting preconditions, silently
    // downgrading an authored precondition to "Invariant violated: <src>" and
    // costing it the wire `code` every other backend keyed.
    const validator = bySuffix(await filesFor("dotnet"), "RestockCommandValidator.cs")!;
    expect(validator).toContain('.WithMessage("Amount must be positive")');
    expect(validator).toContain(`.WithErrorCode("${AMOUNT_CODE}")`);
  });
});

describe("java/Spring — messages.properties ResourceBundle + MessageSource resolution", () => {
  it("emits the bundle keyed by the wire codes", async () => {
    const bundle = bySuffix(await filesFor("java"), "src/main/resources/messages.properties")!;
    expect(bundle).toBeDefined();
    expect(bundle).toContain(`${NAME_CODE}=Name must be 2-120 characters`);
    expect(bundle).toContain(`${SKU_CODE}=SKU is required`);
    expect(bundle).toContain(`${AMOUNT_CODE}=Amount must be positive`);
  });

  it("resolves each FieldError through MessageSource for the ambient locale", async () => {
    const advice = bySuffix(await filesFor("java"), "ApiExceptionAdvice.java")!;
    expect(advice).toContain("import org.springframework.context.MessageSource;");
    expect(advice).toContain("ApiExceptionAdvice(HttpMetrics httpMetrics, MessageSource messages)");
    expect(advice).toContain("Locale.forLanguageTag(RequestContext.locale()");
    expect(advice).toContain('entry.put("message", resolveMessage(err, locale));');
    // A FieldError with no default message must not turn the 422 into a 500.
    expect(advice).toContain("catch (NoSuchMessageException ex)");
  });
});

describe("python/FastAPI — app/i18n.py + validation-handler resolution", () => {
  it("emits the catalog keyed by the wire codes", async () => {
    const catalog = bySuffix(await filesFor("python"), "app/i18n.py")!;
    expect(catalog).toBeDefined();
    expect(catalog).toContain(`"${NAME_CODE}": "Name must be 2-120 characters"`);
    expect(catalog).toContain("from app.obs.log import locale");
  });

  it("resolves errors[].message through the catalog in the 422 handler", async () => {
    const problem = bySuffix(await filesFor("python"), "app/http/problem.py")!;
    expect(problem).toContain("from app.i18n import localize_message");
    expect(problem).toContain('entry["message"] = localize_message(code, entry["message"])');
  });
});

describe("elixir/Phoenix — priv/gettext catalog + changeset-error resolution", () => {
  it("emits the authored messages into the gettext catalog, keyed as msgctxt", async () => {
    const files = await filesFor("elixir");
    const po = bySuffix(files, "priv/gettext/en/LC_MESSAGES/default.po")!;
    expect(po).toBeDefined();
    // pgettext reconciles the two key models: the Loom code is the CONTEXT and
    // the authored English the msgid — identical to the HEEx frontend half.
    expect(po).toContain(`msgctxt "${NAME_CODE}"`);
    expect(po).toContain('msgid "Name must be 2-120 characters"');
    // A `.pot` template ships beside it so `mix gettext.merge` works normally.
    expect(bySuffix(files, "priv/gettext/default.pot")).toContain(`msgctxt "${SKU_CODE}"`);
  });

  it("emits the Gettext backend + hex dep for an API-only deployable (no ui)", async () => {
    // The gettext runtime used to be gated on the mounted ui having strings, so
    // a JSON-API deployable with an authored message had no catalog to resolve.
    const files = await filesFor("elixir");
    expect(bySuffix(files, "_web/gettext.ex")).toBeDefined();
    expect(bySuffix(files, "mix.exs")).toContain("{:gettext,");
  });

  it("resolves the changeset error's loom_code through gettext", async () => {
    const problem = bySuffix(await filesFor("elixir"), "_web/problem_details.ex")!;
    expect(problem).toContain("localize(Keyword.get(opts, :loom_code), interpolated)");
    // The RUNTIME pgettext/4, not the macro — the msgctxt is a runtime value.
    expect(problem).toContain("Gettext.pgettext(ApiWeb.Gettext, code, message)");
    expect(problem).toContain("Api.RequestContext.locale()");
  });
});

describe("cross-backend parity", () => {
  it("all five backends ship the SAME code set — one collector, five renderings", async () => {
    const codesIn = (content: string): string[] =>
      [...new Set(content.match(/msg\.[a-z0-9]+/g) ?? [])].sort();
    const [node, dotnet, java, python, elixir] = await Promise.all([
      filesFor("node"),
      filesFor("dotnet"),
      filesFor("java"),
      filesFor("python"),
      filesFor("elixir"),
    ]);
    expect(codesIn(bySuffix(node, "http/messages.ts")!)).toEqual(ALL_CODES);
    expect(codesIn(bySuffix(dotnet, "Localization/LoomMessages.cs")!)).toEqual(ALL_CODES);
    expect(codesIn(bySuffix(java, "src/main/resources/messages.properties")!)).toEqual(ALL_CODES);
    expect(codesIn(bySuffix(python, "app/i18n.py")!)).toEqual(ALL_CODES);
    expect(
      codesIn(bySuffix(elixir, "priv/gettext/en/LC_MESSAGES/default.po")!).filter((c) =>
        ALL_CODES.includes(c),
      ),
    ).toEqual(ALL_CODES);
  });

  it("the catalog keys equal the keys in the system's .loom/messages.en.json", async () => {
    // ONE system catalog for translators, N runtime catalogs derived from it.
    const files = await filesFor("node");
    const systemCatalog = JSON.parse(files.get(".loom/messages.en.json")!) as Record<
      string,
      string
    >;
    for (const code of ALL_CODES) {
      expect(Object.keys(systemCatalog)).toContain(code);
    }
    expect(systemCatalog[NAME_CODE]).toBe("Name must be 2-120 characters");
  });

  it("all five resolve the SAME locale-lookup contract off the ambient locale", async () => {
    // `RequestContext.locale` is the Accept-Language header VERBATIM (D-CTX-SHAPE),
    // so each rendering must normalise it the same way or a `fr-CA,fr;q=0.9`
    // request would resolve differently per backend.  The contract: take the first
    // listed language, drop its `;q=` weight, then fall back to the primary
    // subtag.  Two backends delegate it to their ecosystem (java to
    // `Locale.forLanguageTag` + ResourceBundle's own parent-bundle walk, elixir to
    // gettext's), so for those the assertion is that the FIRST-TAG extraction
    // happens before the handoff.
    const [node, dotnet, java, python, elixir] = await Promise.all([
      filesFor("node"),
      filesFor("dotnet"),
      filesFor("java"),
      filesFor("python"),
      filesFor("elixir"),
    ]);
    // node / .NET / python own the whole walk, including the primary-subtag step.
    const catalogs = [
      bySuffix(node, "http/messages.ts")!,
      bySuffix(dotnet, "Localization/LoomMessages.cs")!,
      bySuffix(python, "app/i18n.py")!,
    ];
    for (const c of catalogs) {
      expect(c).toMatch(/[Ss]plit\((["'])[,,]\1\)/); // first listed language
      expect(c).toMatch(/[Ss]plit\((["'])[;;]\1\)/); // drop the ;q= weight
      expect(c.toLowerCase()).toContain("primary"); // the subtag fallback
    }
    // java / elixir extract the first tag, then hand the rest to their ecosystem.
    const advice = bySuffix(java, "ApiExceptionAdvice.java")!;
    expect(advice).toContain('RequestContext.locale().split(",")[0].split(";")[0].trim()');
    const problem = bySuffix(elixir, "_web/problem_details.ex")!;
    expect(problem).toContain('String.split(",")');
    expect(problem).toContain('String.split(";")');
  });

  it("a system with no authored message emits no catalog and no lookup", async () => {
    for (const [platform, suffix] of [
      ["node", "http/messages.ts"],
      ["dotnet", "Localization/LoomMessages.cs"],
      ["java", "src/main/resources/messages.properties"],
      ["python", "app/i18n.py"],
      ["elixir", "priv/gettext/en/LC_MESSAGES/default.po"],
    ] as const) {
      const files = await filesFor(platform, NO_MESSAGES);
      expect(bySuffix(files, suffix), `${platform} emitted a catalog with no messages`).toBe(
        undefined,
      );
    }
    // …and the resolution sites keep their pre-catalog form.
    expect(bySuffix(await filesFor("node", NO_MESSAGES), "http/problem-details.ts")).toContain(
      "message: issue.message,",
    );
    expect(bySuffix(await filesFor("python", NO_MESSAGES), "app/http/problem.py")).not.toContain(
      "localize_message",
    );
    expect(bySuffix(await filesFor("java", NO_MESSAGES), "ApiExceptionAdvice.java")).toContain(
      'entry.put("message", err.getDefaultMessage());',
    );
  });
});
