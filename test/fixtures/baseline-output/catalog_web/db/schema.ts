// Auto-generated.
import { pgTable, text, integer, bigint, numeric, boolean, timestamp, pgEnum, uuid, index } from "drizzle-orm/pg-core";


export const products = pgTable("products", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull(),
  price_amount: numeric("price_amount").notNull(),
  price_currency: text("price_currency").notNull(),
}, (table) => ({
    productSkuIdx: index("products_sku_idx").on(table.sku),
}));

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  age: integer("age").notNull(),
}, (table) => ({
    customerEmailIdx: index("customers_email_idx").on(table.email),
}));
