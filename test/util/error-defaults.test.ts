// Stdlib error-status defaults + derived ProblemDetails fields (exception-less.md A1).

import { describe, expect, it } from "vitest";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../src/util/error-defaults.js";

describe("error-defaults — stdlib status table", () => {
  it("maps the blessed stdlib errors to their default statuses", () => {
    expect(defaultErrorStatus("NotFound")).toBe(404);
    expect(defaultErrorStatus("ValidationError")).toBe(422);
    expect(defaultErrorStatus("ParseError")).toBe(400);
    expect(defaultErrorStatus("Forbidden")).toBe(403);
    expect(defaultErrorStatus("TransportFailure")).toBe(502);
  });

  it("falls through to 500 for an unrecognised (user-declared) error", () => {
    expect(defaultErrorStatus("OutOfStock")).toBe(500);
  });
});

describe("error-defaults — derived ProblemDetails fields", () => {
  it("prettifies the error name into a RFC-7807 title", () => {
    expect(errorTitle("NotFound")).toBe("Not Found");
    expect(errorTitle("OutOfStock")).toBe("Out Of Stock");
  });

  it("kebab-cases the error name into a /errors/<name> type URI", () => {
    expect(errorTypeUri("NotFound")).toBe("/errors/not-found");
    expect(errorTypeUri("OutOfStock")).toBe("/errors/out-of-stock");
  });
});
