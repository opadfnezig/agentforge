import type { Knex } from 'knex'

const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

const jsonColumn = (t: Knex.CreateTableBuilder, name: string, defaultVal: string, knex: Knex) => {
  if (isSqlite(knex)) {
    t.text(name).defaultTo(defaultVal)
  } else {
    t.jsonb(name).defaultTo(defaultVal)
  }
}

// Spawn intent rows persist a [spawn, ...] command emitted by the coordinator
// before the user has approved it. Approval flips status → 'approved' and
// triggers a SpawnerClient.spawn() call; the resulting primitive lands in the
// `spawns` table (and event history in `spawn_events`) via the lifecycle
// ingest path. Intents are append-only — they are NOT updated to track the
// spawned primitive's later lifecycle (that's `spawns`).
export const up = async (knex: Knex) => {
  await knex.schema.createTable('spawn_intents', (t) => {
    t.string('id', 36).primary()
    t.string('spawner_host_id', 36)
      .references('id')
      .inTable('spawner_hosts')
      .onDelete('CASCADE')
      .notNullable()
    t.string('primitive_name', 63).notNullable()
    t.string('primitive_kind', 20).notNullable()
    t.string('image', 500).notNullable()
    jsonColumn(t, 'spec', '{}', knex)
    t.string('status', 20).notNullable().defaultTo('pending')
    t.text('error_message').nullable()
    t.timestamp('approved_at').nullable()
    t.timestamp('cancelled_at').nullable()
    t.timestamps(true, true)
    t.index(['spawner_host_id', 'status'], 'spawn_intents_host_status_idx')
    t.index(['status', 'created_at'], 'spawn_intents_status_created_idx')
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('spawn_intents')
}
