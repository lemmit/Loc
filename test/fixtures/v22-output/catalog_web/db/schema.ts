// Auto-generated.
import { pgTable, text, integer, bigint, numeric, boolean, timestamp, pgEnum, uuid, index } from "drizzle-orm/pg-core";


export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  age: integer("age").notNull(),
}, (table) => ({
    customerEmailIdx: index("customers_email_idx").on(table.email),
}));
