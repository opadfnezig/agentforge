import { EventEmitter } from 'events'

// Thin event-bus for ingested lifecycle events. Frontend SSE feed is
// deliberately not wired (Ambiguity A8) — this keeps the door open without
// committing to an SSE route shape.
//
// Emitted events:
//   `event:<host_id>`                       -> LifecycleEvent
//   `event:<host_id>:<primitive_name>`      -> LifecycleEvent
class SpawnerRegistry {
  readonly events = new EventEmitter()
  constructor() {
    this.events.setMaxListeners(0)
  }
}

export const spawnerRegistry = new SpawnerRegistry()
