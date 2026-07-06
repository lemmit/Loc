// Image + Avatar primitives in walker stdlib.
//
//   Image { src: "/logo.png", alt: "Acme" }   → Mantine <Image src=… alt=… />
//   Avatar { src: "/u.png",   alt: "User" }   → Mantine <Avatar src=… alt=… />
//
// Both accept string literals or route-param refs in src/alt
// slots.  Missing attrs are simply omitted — Mantine renders its
// built-in fallback (placeholder image / user-icon).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Image + Avatar in walker stdlib", () => {
  it("Image { src, alt } emits Mantine <Image> with both attrs", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Image { src: "/logo.png", alt: "Acme" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ Image \} from "@mantine\/core";/);
    expect(content).toMatch(/<Image src="\/logo\.png" alt="Acme" \/>/);
  });

  it("Avatar { src, alt } emits Mantine <Avatar> with both attrs", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Avatar { src: "/u.png", alt: "User" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/import \{ Avatar \} from "@mantine\/core";/);
    expect(content).toMatch(/<Avatar src="\/u\.png" alt="User" \/>/);
  });

  // accessibility.md Phase 3 — `decorative: true` renders an explicit empty
  // alt (`alt=""`), hiding a purely-decorative image from assistive tech.
  it('Image { decorative: true } emits alt=""', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Image { "/spacer.png", decorative: true }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/<Image src="\/spacer\.png" alt="" \/>/);
  });

  it("Image with no attrs emits a self-closing Image (Mantine fallback)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Image {}
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/<Image \/>/);
  });

  it("Avatar accepts a route-param ref in src (template-literal interpolation)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Profile(slug: string) {
            route: "/profile/:slug"
            body:  Avatar { src: slug, alt: "User" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/profile.tsx")!;
    // Template-literal interpolation, same shape Button { to: } and
    // Anchor { to: } use for param refs.
    expect(content).toMatch(/<Avatar src=`\$\{slug\}` alt="User" \/>/);
    // Param consumed → destructured in shell.
    expect(content).toMatch(/const \{ slug \} = useParams/);
  });

  it("Image + Avatar in a Toolbar — composition stays clean", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Header {
            route: "/header"
            body:  Toolbar {
              Image { src: "/logo.png", alt: "Acme" },
              Avatar { src: "/u.png", alt: "Me" }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/header.tsx")!;
    expect(content).toMatch(/import \{ Avatar, Group, Image \} from "@mantine\/core";/);
    expect(content).toMatch(/<Group justify="space-between">/);
    expect(content).toMatch(/<Image src="\/logo\.png"/);
    expect(content).toMatch(/<Avatar src="\/u\.png"/);
  });
});
