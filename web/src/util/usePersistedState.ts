import { useEffect, useRef, useState } from "react";

// JSON-backed localStorage state.  Reads once on mount (lazy initial
// state — the read costs ~100 µs but only runs the first render),
// then mirrors every setter call back to localStorage.  Swallows
// quota / parse errors so a wiped or corrupted entry can't crash the
// app — we just fall back to `initial`.
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  // Track the latest value in a ref so the effect below doesn't need
  // `value` in its deps — we only want it firing when `value` actually
  // changes, not when the setter identity churns from re-renders of
  // the consuming component.
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(valueRef.current));
    } catch {
      // Quota exceeded or storage disabled — silently drop the
      // persistence, the in-memory value still tracks correctly.
    }
  }, [key, value]);

  return [value, setValue];
}
