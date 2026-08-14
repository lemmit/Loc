// The one spelling of a store's Riverpod provider, in a LEAF module.
//
// Three modules need it and they sit on both sides of the existing
// `riverpod-emit` ↔ `flutter-target` edge: the store module declares the
// provider (`store-builder.ts`), the page-body seams read it
// (`flutter-target.ts`), and a Notifier method calls a cross-store action
// through it (`riverpod-emit.ts`).  Anything richer than a leaf here would
// close a cycle.

import { lowerFirst } from "../../util/naming.js";

/** The Riverpod provider variable for a store (`Cart` → `cartProvider`) — the
 *  store twin of a stateful page's `<page>Provider`. */
export function storeProviderName(storeName: string): string {
  return `${lowerFirst(storeName)}Provider`;
}
