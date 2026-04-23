import type { Knex } from 'knex'

// Helper to detect SQLite
const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

// Helper for JSON column (JSONB on PostgreSQL, TEXT on SQLite)
const jsonColumn = (t: Knex.CreateTableBuilder, name: string, defaultVal: string, knex: Knex) => {
  if (isSqlite(knex)) {
    t.text(name).defaultTo(defaultVal)
  } else {
    t.jsonb(name).defaultTo(defaultVal)
  }
}

export const up = async (knex: Knex) => {
  // Scopes
  await knex.schema.createTable('scopes', (t) => {
    t.string('id', 36).primary()
    t.string('name').notNullable()
    t.text('description')
    t.string('path').notNullable()
    t.timestamps(true, true)
  })

  // Oracles
  await knex.schema.createTable('oracles', (t) => {
    t.string('id', 36).primary()
    t.string('scope_id', 36).references('id').inTable('scopes').onDelete('CASCADE')
    t.string('name').notNullable()
    t.string('domain').notNullable()
    t.text('description')
    t.string('state_dir').notNullable()
    t.string('status').defaultTo('active')
    jsonColumn(t, 'config', '{}', knex)
    t.timestamps(true, true)
  })

  // Oracle Queries
  await knex.schema.createTable('oracle_queries', (t) => {
    t.string('id', 36).primary()
    t.string('oracle_id', 36).references('id').inTable('oracles').onDelete('CASCADE')
    t.text('message').notNullable()
    t.text('response')
    t.integer('duration_ms')
    t.string('status').defaultTo('pending')
    t.timestamps(true, true)
    t.index(['oracle_id', 'created_at'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('oracle_queries')
  await knex.schema.dropTableIfExists('oracles')
  await knex.schema.dropTableIfExists('scopes')
}
