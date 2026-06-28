import { describe, expect, it } from "vitest";
import {
  escapeCsharpIdent,
  escapeElixirIdent,
  escapeJavaIdent,
  escapePythonIdent,
  escapeTsIdent,
  humanize,
  indent,
  lowerFirst,
  plural,
  snake,
  upperFirst,
} from "../../src/util/naming.js";

describe("naming — upperFirst / lowerFirst", () => {
  it("upper/lower-cases only the first character, leaving the rest intact", () => {
    expect(upperFirst("order")).toBe("Order");
    expect(upperFirst("orderLine")).toBe("OrderLine");
    expect(lowerFirst("Order")).toBe("order");
    expect(lowerFirst("OrderLine")).toBe("orderLine");
  });

  it("returns the empty string unchanged", () => {
    expect(upperFirst("")).toBe("");
    expect(lowerFirst("")).toBe("");
  });
});

describe("naming — snake", () => {
  it("splits camelCase and PascalCase boundaries", () => {
    expect(snake("customerId")).toBe("customer_id");
    expect(snake("OrderLine")).toBe("order_line");
    expect(snake("placedAt")).toBe("placed_at");
  });

  it("splits acronym → word boundaries (APIKey → api_key)", () => {
    expect(snake("APIKey")).toBe("api_key");
  });

  it("leaves an all-lowercase word unchanged", () => {
    expect(snake("order")).toBe("order");
  });
});

describe("naming — plural (conservative rules)", () => {
  it("y → ies only when not preceded by a vowel", () => {
    expect(plural("category")).toBe("categories");
    expect(plural("currency")).toBe("currencies");
    expect(plural("day")).toBe("days");
    expect(plural("key")).toBe("keys");
  });

  it("s / x / z / ch / sh → +es", () => {
    expect(plural("bus")).toBe("buses");
    expect(plural("box")).toBe("boxes");
    expect(plural("buzz")).toBe("buzzes");
    expect(plural("church")).toBe("churches");
    expect(plural("dish")).toBe("dishes");
  });

  it("default → +s", () => {
    expect(plural("order")).toBe("orders");
    expect(plural("product")).toBe("products");
  });
});

describe("naming — humanize", () => {
  it("title-cases camelCase, PascalCase and snake_case identifiers", () => {
    expect(humanize("customerId")).toBe("Customer Id");
    expect(humanize("placedAt")).toBe("Placed At");
    expect(humanize("addLine")).toBe("Add Line");
    expect(humanize("order_total")).toBe("Order Total");
  });

  it("returns the empty string unchanged", () => {
    expect(humanize("")).toBe("");
  });
});

describe("naming — indent", () => {
  it("prefixes each non-empty line with the indent unit", () => {
    expect(indent("a\nb")).toBe("  a\n  b");
    expect(indent("a\nb", 2)).toBe("    a\n    b");
  });

  it("leaves blank lines unprefixed", () => {
    expect(indent("a\n\nb")).toBe("  a\n\n  b");
  });

  it("honours a custom unit", () => {
    expect(indent("a", 1, "\t")).toBe("\ta");
  });
});

describe("naming — target-language keyword escaping", () => {
  it("C# escapes keywords with the verbatim prefix, passes non-keywords through", () => {
    expect(escapeCsharpIdent("base")).toBe("@base");
    expect(escapeCsharpIdent("class")).toBe("@class");
    expect(escapeCsharpIdent("end")).toBe("end"); // not a C# keyword
    expect(escapeCsharpIdent("order")).toBe("order");
  });

  it("TS escapes keywords with a trailing underscore, passes non-keywords through", () => {
    expect(escapeTsIdent("class")).toBe("class_");
    expect(escapeTsIdent("new")).toBe("new_");
    expect(escapeTsIdent("base")).toBe("base"); // not a TS reserved word
    expect(escapeTsIdent("end")).toBe("end");
    expect(escapeTsIdent("order")).toBe("order");
  });

  it("Java escapes keywords with a trailing underscore, passes non-keywords through", () => {
    expect(escapeJavaIdent("class")).toBe("class_");
    expect(escapeJavaIdent("final")).toBe("final_");
    expect(escapeJavaIdent("base")).toBe("base"); // not a Java keyword
    expect(escapeJavaIdent("order")).toBe("order");
  });

  it("Python escapes keywords with a trailing underscore, passes non-keywords through", () => {
    expect(escapePythonIdent("class")).toBe("class_");
    expect(escapePythonIdent("def")).toBe("def_");
    expect(escapePythonIdent("base")).toBe("base"); // not a Python keyword
    expect(escapePythonIdent("order")).toBe("order");
  });

  it("Elixir escapes keywords with a trailing underscore, passes non-keywords through", () => {
    expect(escapeElixirIdent("end")).toBe("end_");
    expect(escapeElixirIdent("fn")).toBe("fn_");
    expect(escapeElixirIdent("class")).toBe("class"); // not an Elixir keyword
    expect(escapeElixirIdent("order")).toBe("order");
  });
});
