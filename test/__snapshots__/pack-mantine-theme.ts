// Auto-generated.  Do not edit by hand.
import { createTheme, type MantineColorsTuple } from "@mantine/core";

const brand: MantineColorsTuple = [
  "#efeefb",
  "#d6d4f6",
  "#bdbaf0",
  "#9e9af1",
  "#847eed",
  "#6962e9",
  "#4f46e5",
  "#241bbe",
  "#161075",
  "#0b092a",
];

const neutral: MantineColorsTuple = [
  "#f3f5f6",
  "#dcdfe4",
  "#c4cad2",
  "#aab4c2",
  "#929fb1",
  "#7a899f",
  "#64748b",
  "#4a5667",
  "#303742",
  "#16191d",
];

export const theme = createTheme({
  primaryColor: "brand",
  primaryShade: { light: 6, dark: 5 },
  colors: { brand, gray: neutral },
  defaultRadius: "md",
  fontFamily: "\"Inter\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace",
  headings: {
    fontFamily: "\"Inter\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "2rem", lineHeight: "1.25" },
      h2: { fontSize: "1.5rem", lineHeight: "1.3" },
      h3: { fontSize: "1.25rem", lineHeight: "1.35" },
      h4: { fontSize: "1rem", lineHeight: "1.4" },
    },
  },
  components: {
    Card: { defaultProps: { shadow: "xs", radius: "md", padding: "lg", withBorder: true } },
    Paper: { defaultProps: { shadow: "xs", radius: "md", withBorder: true } },
    Button: { defaultProps: { radius: "md" } },
    TextInput: { defaultProps: { radius: "md" } },
    NumberInput: { defaultProps: { radius: "md" } },
    Select: { defaultProps: { radius: "md" } },
    Switch: { defaultProps: { radius: "md" } },
    Table: { defaultProps: { verticalSpacing: "sm", horizontalSpacing: "md" } },
    Badge: { defaultProps: { radius: "sm" } },
  },
});
