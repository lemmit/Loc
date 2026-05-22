import { describe, expect, it } from "vitest";
import { camel, humanize, indent, pascal, plural, snake } from "../src/util/naming.js";

describe("naming — pascal / camel", () => {
  it("upper/lower-cases only the first character, leaving the rest intact", () => {
    expect(pascal("order")).toBe("Order");
    expect(pascal("orderLine")).toBe("OrderLine");
    expect(camel("Order")).toBe("order");
    expect(camel("OrderLine")).toBe("orderLine");
  });

  it("returns the empty string unchanged", () => {
    expect(pascal("")).toBe("");
    expect(camel("")).toBe("");
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
