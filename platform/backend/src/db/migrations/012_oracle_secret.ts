import type { Knex } from 'knex'

// Add a per-oracle WS shared secret. Mirrors developer.secret — the oracle
// container connects out to /api/oracles/connect/:id and authenticates via
// ?secret=<secret>. Existing rows get NULL; the secret is generated lazily
// when an oracle is first spawned (or reset via /:id/secret).
export const up = async (knex: Knex) => {
  await knex.schema.alterTable('oracles', (t) => {
    t.string('secret', 64).nullable()
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('oracles', (t) => {
    t.dropColumn('secret')
  })
}
