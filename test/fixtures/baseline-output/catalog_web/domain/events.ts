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
