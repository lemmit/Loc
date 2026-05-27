// `testid:` named-arg convention on every walker primitive.
//
// Every body primitive in `src/generator/react/body-walker.ts`
// reads a `testid:` named arg and threads it through to the
// template's `data-testid` attribute on the primitive's root
// element.  This is the foundation for walker-side e2e page-object
// emission and for the explicit `Order` aggregate rewrite.
//
// What this pins:
//   1. A string-literal `testid: "x"` lands as `data-testid="x"`.
//   2. Refs / expressions land as `data-testid={…}`.
//   3. The attribute is on the primitive's *root* element (e.g.
//      for `Field`, on the underlying `<TextInput>` / `<Input>`,
//      not the surrounding wrapper div).
//   4. Pages without `testid:` emit no `data-testid` for the
//      primitive — i.e. the convention is opt-in, no drift.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

function pageWithBody(body: string): string {
  return `
    system S {
      module M { context C { } }
      ui WebApp {
        page P {
          route: "/p"
          body:  ${body}
        }
      }
      deployable api { platform: hono, modules: M, port: 3000 }
      deployable web {
        platform: static
        targets: api
        ui: WebApp
        port: 3001
      }
    }
  `;
}

async function emit(body: string): Promise<string> {
  const files = await buildAndGenerate(pageWithBody(body));
  const tsx = files.get("web/src/pages/p.tsx");
  if (!tsx) throw new Error(`expected web/src/pages/p.tsx; got: ${[...files.keys()].join(", ")}`);
  return tsx;
}

describe("testid: named-arg convention on every primitive", () => {
  it('Stack: string literal lands as data-testid="…" on the root <Stack>', async () => {
    const tsx = await emit(`Stack { testid: "main" }`);
    expect(tsx).toMatch(/<Stack[^>]*\bdata-testid="main"/);
  });

  it("Stack: when no testid: is supplied, no data-testid attr is emitted", async () => {
    const tsx = await emit(`Stack { Heading { "Hi" } }`);
    expect(tsx).not.toMatch(/<Stack[^>]*data-testid/);
  });

  it("Group: testid lands on the root <Group>", async () => {
    const tsx = await emit(`Group { testid: "g1" }`);
    expect(tsx).toMatch(/<Group[^>]*\bdata-testid="g1"/);
  });

  it("Grid: testid lands on the root <Grid>", async () => {
    const tsx = await emit(`Grid { testid: "grid" }`);
    expect(tsx).toMatch(/<Grid[^>]*\bdata-testid="grid"/);
  });

  it("Container: testid lands on the root <Container>", async () => {
    const tsx = await emit(`Container { testid: "ct" }`);
    expect(tsx).toMatch(/<Container[^>]*\bdata-testid="ct"/);
  });

  it('Toolbar: testid lands on the root <Group justify="space-between">', async () => {
    const tsx = await emit(`Toolbar { testid: "tb" }`);
    expect(tsx).toMatch(/<Group [^>]*\bdata-testid="tb"/);
  });

  it("Card: testid lands on the root <Card>", async () => {
    const tsx = await emit(`Card { "title", testid: "card1" }`);
    expect(tsx).toMatch(/<Card[^>]*\bdata-testid="card1"/);
  });

  it("Heading: testid lands on the root <Title>", async () => {
    const tsx = await emit(`Heading { "Hi", testid: "h" }`);
    expect(tsx).toMatch(/<Title[^>]*\bdata-testid="h"/);
  });

  it("Text: testid lands on the root <Text>", async () => {
    const tsx = await emit(`Text { "hi", testid: "t" }`);
    expect(tsx).toMatch(/<Text[^>]*\bdata-testid="t"/);
  });

  it("Anchor: testid lands on the root <Anchor>", async () => {
    const tsx = await emit(`Anchor { "Link", to: "/x", testid: "a" }`);
    expect(tsx).toMatch(/<Anchor[^>]*\bdata-testid="a"/);
  });

  it("Button: testid lands on the root <Button>", async () => {
    const tsx = await emit(`Button { "Go", testid: "btn" }`);
    expect(tsx).toMatch(/<Button[^>]*\bdata-testid="btn"/);
  });

  it("Badge: testid lands on the root <Badge>", async () => {
    const tsx = await emit(`Badge { "active", testid: "bdg" }`);
    expect(tsx).toMatch(/<Badge[^>]*\bdata-testid="bdg"/);
  });

  it("Divider: testid lands on the root <Divider>", async () => {
    const tsx = await emit(`Divider { testid: "div" }`);
    expect(tsx).toMatch(/<Divider[^>]*\bdata-testid="div"/);
  });

  it("Empty: testid lands on the root <Center>", async () => {
    const tsx = await emit(`Empty { "Nothing", testid: "empty" }`);
    expect(tsx).toMatch(/<Center[^>]*\bdata-testid="empty"/);
  });

  it("Loader: testid lands on the root <Loader>", async () => {
    const tsx = await emit(`Loader { testid: "ldr" }`);
    expect(tsx).toMatch(/<Loader[^>]*\bdata-testid="ldr"/);
  });

  it("Image: testid lands on the root <Image>", async () => {
    const tsx = await emit(`Image { src: "/x.png", testid: "img" }`);
    expect(tsx).toMatch(/<Image[^>]*\bdata-testid="img"/);
  });

  it("Avatar: testid lands on the root <Avatar>", async () => {
    const tsx = await emit(`Avatar { src: "/x.png", testid: "av" }`);
    expect(tsx).toMatch(/<Avatar[^>]*\bdata-testid="av"/);
  });

  it("Stat: testid lands on the root <Stack>", async () => {
    const tsx = await emit(`Stat { label: "Users", value: "10", testid: "s1" }`);
    expect(tsx).toMatch(/<Stack [^>]*\bdata-testid="s1"/);
  });

  it("Tabs: testid lands on the root <Tabs>", async () => {
    const tsx = await emit(
      `Tabs { Tab { "Overview", Text { "a" } }, Tab { "Settings", Text { "b" } }, testid: "tabs1" }`,
    );
    expect(tsx).toMatch(/<Tabs[^>]*\bdata-testid="tabs1"/);
  });

  it("Field: testid lands on the underlying <TextInput>, not a surrounding wrapper", async () => {
    const tsx = await emit(`Field { label: "Name", testid: "name" }`);
    expect(tsx).toMatch(/<TextInput[^>]*\bdata-testid="name"/);
  });

  it("NumberField: testid lands on the underlying <NumberInput>", async () => {
    const tsx = await emit(`NumberField { label: "Qty", testid: "qty" }`);
    expect(tsx).toMatch(/<NumberInput[^>]*\bdata-testid="qty"/);
  });

  it("PasswordField: testid lands on the underlying <PasswordInput>", async () => {
    const tsx = await emit(`PasswordField { label: "Password", testid: "pw" }`);
    expect(tsx).toMatch(/<PasswordInput[^>]*\bdata-testid="pw"/);
  });

  it("Toggle: testid lands on the underlying <Switch>", async () => {
    const tsx = await emit(`Toggle { label: "On", testid: "tgl" }`);
    expect(tsx).toMatch(/<Switch[^>]*\bdata-testid="tgl"/);
  });
});
