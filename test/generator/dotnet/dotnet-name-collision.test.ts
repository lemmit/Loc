// `loom.dotnet-name-collision` (field-test F11) — the dotnet backend puts every
// declared member of an aggregate in a bare C# member position on the aggregate
// class, while the SAME class body reaches its sibling TYPES by simple name.
// C# resolves a simple name in EXPRESSION position against the enclosing
// class's members first, so a member whose C# name equals one of those types
// hides it and the generated C# stops compiling.  Both failure codes were
// reproduced under `dotnet build /warnaserror` before this gate was written:
//
//   operation comment(...)  beside `entity Comment`
//     → public void Comment(string, string) { _comments.Add(Comment._Create(…
//     → CS0119: 'Issue.Comment(string, string)' is a method, which is not
//       valid in the given context
//
//   comment: string         beside `entity Comment`
//     → public string Comment { get; private set; }
//     → CS1061: 'string' does not contain a definition for '_Create'
//
// The BOUNDARY is the interesting half: C#'s "Color Color" rule (§12.8.7.2)
// deliberately permits a field/property whose own type is the type it shadows,
// so `public Kind Kind` and `public Money Money` compile — probed against the
// real compiler, and pinned below so the gate can't drift into refusing models
// that build today.  The dotnet compile-tier fixture
// `test/e2e/fixtures/dotnet-build/name-collision-neighbours.ddd` is the other
// half of that boundary: it carries every legal neighbour and must keep
// building, which it cannot do if this gate over-fires (generation aborts).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { parseString } from "../../_helpers/parse.js";

const CODE = "loom.dotnet-name-collision";

/** `.ddd` around one aggregate body, hosted on `platform`. */
function system(aggregateBody: string, platform = "dotnet", contextExtras = ""): string {
  return `
    system Coll {
      subdomain Core {
        context Tracking {
          ${contextExtras}
          aggregate Issue {
            ${aggregateBody}
          }
          repository Issues for Issue { }
        }
      }
      api TrackingApi from Core
      storage primary { type: postgres }
      resource appState { for: Tracking, kind: state, use: primary }
      deployable api {
        platform: ${platform}
        contexts: [Tracking]
        dataSources: [appState]
        serves: TrackingApi
        port: 8080
      }
    }`;
}

async function collisions(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code === CODE)
    .map((d) => d.message);
}

// The exact F11 shape: an operation whose C# method name is its own sibling
// entity part's class name.
const COLLIDING_OPERATION = `
  title: string
  contains comments: Comment[]
  operation comment(author: string, body: string) {
    comments += Comment { author: author, body: body }
  }
  entity Comment {
    author: string
    body: string
  }`;

describe("loom.dotnet-name-collision", () => {
  it("refuses an operation whose C# method name shadows a sibling entity part", async () => {
    const diags = await collisions(system(COLLIDING_OPERATION));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain("declares operation 'comment'");
    expect(diags[0]).toContain("C# member 'Comment'");
    // The message names the way out, not just the problem.
    expect(diags[0]).toContain("addComment");
  });

  it("refuses a FIELD that shadows a sibling entity part (the CS1061 half)", async () => {
    const diags = await collisions(
      system(`
        title: string
        comment: string
        contains comments: Comment[]
        entity Comment {
          author: string
          body: string
        }`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain("declares field 'comment'");
  });

  it("is scoped to dotnet — the same model on node is untouched", async () => {
    expect(await collisions(system(COLLIDING_OPERATION, "node"))).toEqual([]);
    expect(await collisions(system(COLLIDING_OPERATION, "python"))).toEqual([]);
  });

  it("accepts the renamed operation", async () => {
    const diags = await collisions(
      system(`
        title: string
        contains comments: Comment[]
        operation addComment(author: string, body: string) {
          comments += Comment { author: author, body: body }
        }
        entity Comment {
          author: string
          body: string
        }`),
    );
    expect(diags).toEqual([]);
  });

  it("does not fire on the C# 'Color Color' shapes, which compile", async () => {
    const diags = await collisions(
      system(
        `
        title: string
        kind: Kind
        money: Money
        contains comments: Comment[]
        entity Comment {
          author: string
          body: string
        }`,
        "dotnet",
        `enum Kind { Bug, Feature }
         valueobject Money { amount: int currency: string }`,
      ),
    );
    expect(diags).toEqual([]);
  });

  it("DOES fire on a collection member named after its element type (no Color Color rescue)", async () => {
    // `IReadOnlyList<Comment> Comment` has type `IReadOnlyList<Comment>`, not
    // `Comment`, so the rule that rescues `public Kind Kind` does not apply.
    const diags = await collisions(
      system(`
        title: string
        contains comment: Comment[]
        entity Comment {
          author: string
          body: string
        }`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain("declares containment 'comment'");
  });

  it("refuses a member shadowing an id class, an enum and an event", async () => {
    const diags = await collisions(
      system(
        `
        title: string
        function issueId(): string = title
        function severity(): string = title
        function issueOpened(): string = title`,
        "dotnet",
        `enum Severity { Low, High }
         event IssueOpened { at: datetime }`,
      ),
    );
    // `IssueId` (Api.Domain.Ids), `Severity` (…Enums) and `IssueOpened`
    // (…Events) are all reachable by simple name from the aggregate class.
    expect(diags).toHaveLength(3);
    expect(diags.join("\n")).toContain("'IssueId'");
    expect(diags.join("\n")).toContain("'Severity'");
    expect(diags.join("\n")).toContain("'IssueOpened'");
  });

  it("reports one diagnostic per name, not one per hosting deployable", async () => {
    const source = `
      system Coll {
        subdomain Core {
          context Tracking {
            aggregate Issue {
              title: string
              contains comments: Comment[]
              operation comment(author: string, body: string) {
                comments += Comment { author: author, body: body }
              }
              entity Comment { author: string body: string }
            }
            repository Issues for Issue { }
          }
        }
        api TrackingApi from Core
        storage primary { type: postgres }
        resource appState { for: Tracking, kind: state, use: primary }
        deployable api {
          platform: dotnet
          contexts: [Tracking]
          dataSources: [appState]
          serves: TrackingApi
          port: 8080
        }
        deployable api2 {
          platform: dotnet
          contexts: [Tracking]
          dataSources: [appState]
          serves: TrackingApi
          port: 8081
        }
      }`;
    expect(await collisions(source)).toHaveLength(1);
  });
});
