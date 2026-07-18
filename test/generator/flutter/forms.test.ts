// Flutter FORMS — the Track B whole-primitive form overrides
// (`CreateForm` / `OperationForm` / `DestroyForm`).  Two tiers: the form
// projector (`collectFlutterForms` / `renderFormWidget`) driven off a
// lowered+enriched ui (string assertions on the emitted `StatefulWidget`s), and
// the end-to-end `generate system` wiring (a form page references the generated
// widget class + imports `../forms.dart`).  No Dart is compiled here — the local
// Flutter SDK gate (`flutter analyze` clean + `build web` green) was run by hand
// during development and `generated-flutter-build.yml` owns it in CI.

import { describe, expect, it } from "vitest";
import {
  collectFlutterForms,
  flutterCreateForm,
} from "../../../src/generator/flutter/forms-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A Product aggregate exercising every field kind (string / number-int /
// number-double / bool / enum / datetime / optional text / flattened value
// object) + a param-bearing operation, hosted on a create page and an admin page
// (op + destroy on a `:id` route).
const SRC = `
system FormsDemo {
  subdomain S {
    context Shop {
      enum Status { draft active archived }
      valueobject Money { amount: int  currency: string }
      aggregate Product {
        name: string
        price: int
        weight: decimal
        active: bool
        status: Status
        launchedAt: datetime
        note: string?
        cost: Money
        operation discount(percent: int) { }
      }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: flutter
    api Shop: ShopApi

    page NewProduct {
      route: "/products/new"
      body: Stack {
        Heading { "New Product", level: 1 },
        CreateForm { of: Product }
      }
    }

    page ProductAdmin {
      route: "/products/:id/admin"
      body: Stack {
        Heading { "Admin", level: 1 },
        OperationForm { of: Product, op: discount },
        DestroyForm { of: Product }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: ShopApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

async function enriched() {
  const { model } = await parseString(SRC, { validate: false });
  return enrichLoomModel(lowerModel(model));
}

describe("flutter form projector", () => {
  it("collects one form widget per hosted CreateForm / OperationForm / DestroyForm", async () => {
    const model = await enriched();
    const ui = model.systems[0]!.uis[0]!;
    const contexts = allContexts(model);
    const aggregatesByName = new Map(contexts.flatMap((c) => c.aggregates.map((a) => [a.name, a])));
    const bcByAggregate = new Map(contexts.flatMap((c) => c.aggregates.map((a) => [a.name, c])));

    const forms = collectFlutterForms(ui, aggregatesByName, bcByAggregate);
    const names = forms.map((f) => f.widgetName).sort();
    expect(names).toEqual(["CreateProductForm", "DeleteProductForm", "DiscountProductForm"]);

    const create = forms.find((f) => f.widgetName === "CreateProductForm")!;
    expect(create.kind).toBe("create");
    expect(create.needsId).toBe(false);
    expect(create.pathExpr).toBe("/products");

    const op = forms.find((f) => f.widgetName === "DiscountProductForm")!;
    expect(op.kind).toBe("operation");
    expect(op.needsId).toBe(true);
    expect(op.pathExpr).toBe(`/products/\${widget.id}/discount`);
    expect(op.fields.map((f) => f.wireName)).toEqual(["percent"]);

    const destroy = forms.find((f) => f.widgetName === "DeleteProductForm")!;
    expect(destroy.kind).toBe("destroy");
    expect(destroy.needsId).toBe(true);
    expect(destroy.destructive).toBe(true);
    expect(destroy.pathExpr).toBe(`/products/\${widget.id}`);
    expect(destroy.fields).toHaveLength(0);
  });

  it("derives the input widget from each field's wire type + flattens value objects", async () => {
    const model = await enriched();
    const contexts = allContexts(model);
    const product = contexts.flatMap((c) => c.aggregates).find((a) => a.name === "Product")!;
    const bc = contexts.find((c) => c.aggregates.some((a) => a.name === "Product"));

    const create = flutterCreateForm(product, bc);
    const byName = new Map(create.fields.map((f) => [f.wireName, f]));

    expect(byName.get("name")!.kind).toBe("text");
    expect(byName.get("price")!.kind).toBe("number-int");
    expect(byName.get("weight")!.kind).toBe("number-double");
    expect(byName.get("active")!.kind).toBe("bool");
    expect(byName.get("status")!.kind).toBe("enum");
    expect(byName.get("status")!.enumValues).toEqual(["draft", "active", "archived"]);
    expect(byName.get("launchedAt")!.kind).toBe("datetime");
    // An optional field isn't required (no validator / null-on-empty).
    expect(byName.get("note")!.required).toBe(false);
    // The `cost: Money` value object flattens into scalar sub-fields grouped
    // under the `cost` JSON object key.
    const amount = byName.get("costAmount")!;
    expect(amount.kind).toBe("number-int");
    expect(amount.objectKey).toBe("cost");
    expect(amount.jsonKey).toBe("amount");
    expect(byName.get("costCurrency")!.jsonKey).toBe("currency");
  });
});

describe("flutter form pages (generate system)", () => {
  it("emits lib/forms.dart with a StatefulWidget per form + config.dart, and wires the pages", async () => {
    const files = await generateSystemFiles(SRC);
    const keys = [...files.keys()];

    const formsKey = keys.find((k) => k.endsWith("app/lib/forms.dart"));
    const configKey = keys.find((k) => k.endsWith("app/lib/config.dart"));
    expect(formsKey, `no forms.dart in: ${keys.join(", ")}`).toBeDefined();
    // The form widgets fetch over apiUri (config.dart), so it must be emitted
    // even though this ui issues no reads.
    expect(configKey, `no config.dart in: ${keys.join(", ")}`).toBeDefined();

    const forms = files.get(formsKey!)!;
    // Create form — a StatefulWidget with a Form key, one input per field, and a
    // POST that pops on success.
    expect(forms).toContain("class CreateProductForm extends StatefulWidget");
    expect(forms).toContain("final _formKey = GlobalKey<FormState>();");
    expect(forms).toContain("final _nameController = TextEditingController();");
    expect(forms).toContain("bool _active = false;");
    expect(forms).toContain("String? _status = 'draft';");
    expect(forms).toContain("DateTime? _launchedAt;");
    expect(forms).toContain("await http.post(apiUri('/products'),");
    expect(forms).toContain("Navigator.of(context).pop();");
    // Value-object grouping in the request body.
    expect(forms).toContain("'cost': <String, dynamic>{");
    expect(forms).toContain("'amount': int.tryParse(_costAmountController.text),");
    // Widget kinds.
    expect(forms).toContain("SwitchListTile(title: const Text('Active')");
    expect(forms).toContain("DropdownButtonFormField<String>(initialValue: _status");
    expect(forms).toContain("showDatePicker(");

    // Operation form — carries the route id + POSTs to the op route.
    expect(forms).toContain("class DiscountProductForm extends StatefulWidget");
    expect(forms).toContain("final String id;");
    expect(forms).toContain(`await http.post(apiUri('/products/\${widget.id}/discount'),`);

    // Destroy form — a DELETE styled as a destructive action.
    expect(forms).toContain("class DeleteProductForm extends StatefulWidget");
    expect(forms).toContain(`await http.delete(apiUri('/products/\${widget.id}'));`);
    expect(forms).toContain("backgroundColor: Theme.of(context).colorScheme.error");

    // Create page — a StatelessWidget referencing the const create-form widget +
    // importing forms.dart.
    const newPage = files.get(keys.find((k) => k.endsWith("new_product_page.dart"))!)!;
    expect(newPage).toContain("import '../forms.dart';");
    expect(newPage).toContain("const CreateProductForm(),");

    // Admin page — binds the route id and passes it to the op + destroy forms.
    const adminPage = files.get(keys.find((k) => k.endsWith("product_admin_page.dart"))!)!;
    expect(adminPage).toContain("import '../forms.dart';");
    expect(adminPage).toContain(
      "final id = (ModalRoute.of(context)?.settings.arguments as String?) ?? '';",
    );
    expect(adminPage).toContain("DiscountProductForm(id: id),");
    expect(adminPage).toContain("DeleteProductForm(id: id),");
  });
});
