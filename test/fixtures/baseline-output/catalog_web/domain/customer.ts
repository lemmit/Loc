// Auto-generated.
import * as Ids from "./ids";
import type * as Events from "./events";
import { DomainError } from "./errors";

export class Customer {
  private _id: Ids.CustomerId;
  private _events: Events.DomainEvent[] = [];
  private _username: string;
  private _email: string;
  private _age: number;
  private constructor(state: { id: Ids.CustomerId; username: string; email: string; age: number }, trustStore = false) {
    this._id = state.id;
    this._username = state.username;
    this._email = state.email;
    this._age = state.age;
    if (!trustStore) {
      this._assertInvariants();
    }
  }

  get id(): Ids.CustomerId { return this._id; }
  get username(): string { return this._username; }
  get email(): string { return this._email; }
  get age(): number { return this._age; }
  get display(): string { return this._username; }
  get inspect(): string { return "Customer(" + "id: " + String(this._id) + ", " + "username: " + "'" + this._username + "'" + ", " + "email: " + "'" + this._email + "'" + ", " + "age: " + String(this._age) + ")"; }
  toString(): string { return this.inspect; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return this.inspect; }
  public update(username: string, email: string, age: number): void {
    this._username = username;
    this._email = email;
    this._age = age;
    this._assertInvariants();
  }

  pullEvents(): Events.DomainEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }

  private _assertInvariants(): void {
    if (!(this._username !== this._email)) throw new DomainError("Invariant violated: username != email");
    if (!(/^[a-z][a-z0-9_]*$/.test(this._username))) throw new DomainError("Invariant violated: username.matches(\"^[a-z][a-z0-9_]*$\")");
    if (!(this._username.length >= 3 && this._username.length <= 32)) throw new DomainError("Invariant violated: username check username.length >= 3 && username.length <= 32");
    if (!(/^[^@]+@[^@]+\.[^@]+$/.test(this._email) && this._email.length <= 120)) throw new DomainError("Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120");
    if (!(this._age >= 18 && this._age <= 150)) throw new DomainError("Invariant violated: age check age >= 18 && age <= 150");
  }

  static _create(state: { id: Ids.CustomerId; username: string; email: string; age: number }): Customer {
    return new Customer(state);
  }

  /** Reconstitution from the store — trusts persisted state, so no
   *  invariant run: invariants guard transitions (create + operations),
   *  not loads.  Repository hydration only; domain code constructs via
   *  `create`/`_create`, which assert. */
  static _rehydrate(state: { id: Ids.CustomerId; username: string; email: string; age: number }): Customer {
    return new Customer(state, true);
  }
  static create(input: { username: string; email: string; age: number }): Customer {
    return new Customer({
      id: Ids.newCustomerId(),
      username: input.username,
      email: input.email,
      age: input.age,
    });
  }
}

