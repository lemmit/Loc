# 18. Testing

> **Grammar:** `TestBlock` (`test`), `TestE2E` (`test e2e`), `ExpectStmt` · **Validators:** test checks in `src/ir/validate/checks/test-checks` · **Docs:** [`../language.md`](../language.md)

In-language tests: `test` unit blocks (vitest/xUnit) and `test e2e` against a running deployable, the `expect(...).matcher(...)` assertion vocabulary, and the automatic api-vs-ui dispatch from the target platform.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`test`** — unit test at aggregate root; precondition/let/expect/emit/calls.
- **`test e2e`** — `against <Deployable>`; api surface (`api.<agg>.<verb>`) vs ui surface (`ui.<agg>.<verb>`).
- **Matchers** — toBe, comparisons, toThrow(/status), toHaveText/Count/Visible/Property.
- **Automatic dispatch** — api → vitest+fetch, ui → Playwright page objects, chosen from the deployable platform.
