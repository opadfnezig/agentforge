import type { Knex } from 'knex'

const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

const jsonColumn = (t: Knex.CreateTableBuilder, name: string, defaultVal: string, knex: Knex) => {
  if (isSqlite(knex)) {
    t.text(name).defaultTo(defaultVal)
  } else {
    t.jsonb(name).defaultTo(defaultVal)
  }
}

export const up = async (knex: Knex) => {
  await knex.schema.createTable('spawner_hosts', (t) => {
    t.string('id', 36).primary()
    t.string('host_id', 64).notNullable().unique()
    t.string('name', 100).notNullable()
    t.string('base_url', 500).notNullable()
    t.string('status', 20).notNullable().defaultTo('unknown')
    t.string('version', 40).nullable()
    jsonColumn(t, 'capabilities', '[]', knex)
    t.timestamp('last_seen_at').nullable()
    t.timestamp('last_event_at').nullable()
    t.text('last_error').nullable()
    jsonColumn(t, 'config', '{}', knex)
    t.timestamps(true, true)
    t.index(['status'])
  })

  await knex.schema.createTable('spawns', (t) => {
    t.string('id', 36).primary()
    t.string('spawner_host_id', 36)
      .references('id')
      .inTable('spawner_hosts')
      .onDelete('CASCADE')
      .notNullable()
    t.string('primitive_name', 63).notNullable()
    t.string('primitive_kind', 20).notNullable()
    t.string('state', 20).notNullable()
    t.string('prev_state', 20).nullable()
    t.string('last_event_id', 36).nullable()
    t.timestamp('last_event_at').notNullable()
    jsonColumn(t, 'payload', '{}', knex)
    t.timestamps(true, true)
    t.unique(['spawner_host_id', 'primitive_name'])
    t.index(['spawner_host_id', 'state'])
  })

  await knex.schema.createTable('spawn_events', (t) => {
    t.string('id', 36).primary()
    t.string('spawner_host_id', 36)
      .references('id')
      .inTable('spawner_hosts')
      .onDelete('CASCADE')
      .notNullable()
    t.string('event_id', 36).notNullable().unique()
    t.string('primitive_name', 63).notNullable()
    t.string('primitive_kind', 20).notNullable()
    t.string('state', 20).notNullable()
    t.string('prev_state', 20).nullable()
    t.timestamp('event_timestamp').notNullable()
    jsonColumn(t, 'payload', '{}', knex)
    t.timestamp('received_at').notNullable().defaultTo(knex.fn.now())
    t.index(['spawner_host_id', 'primitive_name', 'event_timestamp'], 'spawn_events_history_idx')
    t.index(['received_at'], 'spawn_events_received_idx')
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('spawn_events')
  await knex.schema.dropTableIfExists('spawns')
  await knex.schema.dropTableIfExists('spawner_hosts')
}
