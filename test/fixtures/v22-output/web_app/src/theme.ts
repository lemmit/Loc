// Auto-generated.  Do not edit by hand.
import { createTheme, type MantineColorsTuple } from "@mantine/core";

const brand: MantineColorsTuple = [
  "#edf3fd",
  "#d2e1f9",
  "#b6cef6",
  "#93bafa",
  "#76a8f9",
  "#5895f7",
  "#3b82f6",
  "#0a56d3",
  "#063582",
  "#06152d",
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
  colors: {
    brand,
    gray: neutral,
  },
  defaultRadius: "md",
  fontFamily: "Inter, system-ui, sans-serif",
  headings: { fontFamily: "Inter, system-ui, sans-serif" },
});
