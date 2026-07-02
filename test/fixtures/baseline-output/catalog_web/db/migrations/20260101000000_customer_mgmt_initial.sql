CREATE SCHEMA IF NOT EXISTS "customers";
CREATE TABLE "customers"."customers" (
  "id" UUID NOT NULL,
  "username" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "age" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);
