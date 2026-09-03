// Auto-generated.
export type DomainEvent = never;

/**
 * Pluggable boundary for domain events drained from aggregates by the
 * repository.  The default no-op implementation lives in this file; replace
 * it with an outbox writer / message-bus publisher to wire events into
 * your infrastructure.
 */
export interface DomainEventDispatcher {
  dispatch(event: DomainEvent): Promise<void>;
  /**
   * Transactional-outbox capture (dispatch-delivery-semantics.md §1).
   * Called by a repository from INSIDE its save transaction, with that
   * transaction's handle, so a durable event's outbox row commits
   * atomically with the aggregate write.  Returns the events that still
   * need in-process dispatch after the commit.  Optional: a dispatcher
   * without a durable tier omits it and every event is dispatched
   * post-commit (the at-most-once inline path).
   */
  recordDurable?(events: readonly DomainEvent[], tx: unknown): Promise<DomainEvent[]>;
}

export const NoopDomainEventDispatcher: DomainEventDispatcher = {
  async dispatch(_event: DomainEvent): Promise<void> {
    /* no-op */
  },
};

/**
 * Buffer events raised inside a CALLER-OWNED transaction, and dispatch
 * them only once that transaction has committed.
 *
 * A repository dispatches at the end of `save()`, which is correct when it
 * owns its handle: its own `db.transaction(...)` has committed by then.
 * The audit / provenance routes hand the repository the ROUTE's `tx`, so
 * that same line runs while the request transaction is still OPEN — and an
 * in-process subscriber that touches the database then either
 * self-deadlocks (a single-connection driver such as PGlite: the handle it
 * queries is the one the open transaction holds) or reads pre-commit state
 * on a pool.  The workflow routes already avoid this by dispatching after
 * the callback returns; this makes the aggregate routes do the same.
 *
 * `flush()` runs only on the success path, so a rollback discards the
 * buffer rather than announcing writes that were undone.
 */
export function deferredDispatcher(
  inner: DomainEventDispatcher,
): DomainEventDispatcher & { flush(): Promise<void> } {
  const buffered: DomainEvent[] = [];
  return {
    async dispatch(event: DomainEvent): Promise<void> {
      buffered.push(event);
    },
    // Durable capture still belongs INSIDE the transaction — that is the
    // whole point of the outbox row committing atomically with the write —
    // so it is delegated straight through rather than buffered.
    recordDurable: inner.recordDurable?.bind(inner),
    async flush(): Promise<void> {
      for (const event of buffered.splice(0)) await inner.dispatch(event);
    },
  };
}
