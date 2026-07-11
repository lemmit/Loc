// Auto-generated.
import { DomainError } from "./errors";

export class Money {
  readonly amount: number;
  readonly currency: string;
  constructor(
    amount: number,
    currency: string
  ) {
    this.amount = amount;
    this.currency = currency;
    if (!(this.amount >= 0)) throw new DomainError("Invariant violated: amount >= 0");
    if (!(this.currency.length === 3)) throw new DomainError("Invariant violated: currency.length == 3");
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

}

