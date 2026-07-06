// Auto-generated.
import { DomainError } from "./errors";

export class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: string
  ) {
    if (!(this.amount >= 0)) throw new DomainError("Invariant violated: amount >= 0");
    if (!(this.currency.length === 3)) throw new DomainError("Invariant violated: currency.length == 3");
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

}

