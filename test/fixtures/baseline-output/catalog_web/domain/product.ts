// Auto-generated.
import * as Ids from "./ids";
import type { Money } from "./value-objects";
import type * as Events from "./events";
import { DomainError } from "./errors";

export class Product {
  private _id: Ids.ProductId;
  private _events: Events.DomainEvent[] = [];
  private _sku: string;
  private _price: Money;
  private _version: number;
  private constructor(state: { id: Ids.ProductId; sku: string; price: Money; version: number }, trustStore = false) {
    this._id = state.id;
    this._sku = state.sku;
    this._price = state.price;
    this._version = state.version;
    if (!trustStore) {
      this._assertInvariants();
    }
  }

  get id(): Ids.ProductId { return this._id; }
  get sku(): string { return this._sku; }
  get price(): Money { return this._price; }
  get version(): number { return this._version; }
  get display(): string { return this._sku; }
  get inspect(): string { return "Product(" + "id: " + String(this._id) + ", " + "sku: " + "'" + this._sku + "'" + ", " + "price: " + "Money(" + "amount: " + String(this._price.amount) + ", " + "currency: " + "'" + this._price.currency + "'" + ")" + ", " + "version: " + String(this._version) + ")"; }
  toString(): string { return this.inspect; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return this.inspect; }
  public update(sku: string, price: Money): void {
    this._sku = sku;
    this._price = price;
    this._assertInvariants();
  }

  pullEvents(): Events.DomainEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }

  private _assertInvariants(): void {
    if (!(this._sku.length > 0)) throw new DomainError("Invariant violated: sku.length > 0");
  }

  static _create(state: { id: Ids.ProductId; sku: string; price: Money; version: number }): Product {
    return new Product(state);
  }

  /** Reconstitution from the store — trusts persisted state, so no
   *  invariant run: invariants guard transitions (create + operations),
   *  not loads.  Repository hydration only; domain code constructs via
   *  `create`/`_create`, which assert. */
  static _rehydrate(state: { id: Ids.ProductId; sku: string; price: Money; version: number }): Product {
    return new Product(state, true);
  }
  static create(input: { sku: string; price: Money }): Product {
    return new Product({
      id: Ids.newProductId(),
      sku: input.sku,
      price: input.price,
      version: 0,
    });
  }
}

