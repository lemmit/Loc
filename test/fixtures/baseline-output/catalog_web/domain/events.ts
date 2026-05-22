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
}

export const NoopDomainEventDispatcher: DomainEventDispatcher = {
  async dispatch(_event: DomainEvent): Promise<void> {
    /* no-op */
  },
};
