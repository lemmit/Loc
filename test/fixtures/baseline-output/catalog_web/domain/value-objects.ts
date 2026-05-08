// Auto-generated.

export class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: string
  ) {
    if (!(this.amount >= 0)) throw new Error("Invariant violated: amount >= 0");
    if (!(this.currency.length === 3)) throw new Error("Invariant violated: currency.length == 3");
  }

}

