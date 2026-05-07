// Vite's `?raw` suffix gives us the file's text content as a string.
// Adding more examples is just another `?raw` import + an entry in
// the array below.
import salesSource from "./sales.ddd?raw";

export interface LoomExample {
  id: string;
  label: string;
  source: string;
}

export const examples: LoomExample[] = [
  { id: "sales", label: "Sales (single context)", source: salesSource },
];

export const defaultExample = examples[0];
