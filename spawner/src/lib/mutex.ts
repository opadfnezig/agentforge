/**
 * In-process mutex for serializing compose-file writes.
 *
 * The single shared compose.yml at ~/ntfr/compose.yml is mutated by every
 * spawn/destroy. Concurrent writers would race on read-modify-write. We
 * funnel every compose mutation + `docker compose up -d` invocation through
 * this single mutex.
 */
export class Mutex {
  private chain: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((r) => { release = r })
    const prev = this.chain
    this.chain = prev.then(() => next)
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

export const composeMutex = new Mutex()
