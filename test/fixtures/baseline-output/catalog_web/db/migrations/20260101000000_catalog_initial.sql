CREATE SCHEMA IF NOT EXISTS "products";
CREATE TABLE "products"."products" (
  "id" UUID NOT NULL,
  "sku" TEXT NOT NULL,
  "price_amount" DECIMAL NOT NULL,
  "price_currency" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);
