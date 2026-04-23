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
  // Developers
  await knex.schema.createTable('developers', (t) => {
    t.string('id', 36).primary()
    t.string('name', 100).notNullable()
    t.string('scope_id', 36).references('id').inTable('scopes').onDelete('SET NULL').nullable()
    t.string('workspace_path', 500).notNullable()
    t.string('git_repo', 500).nullable()
    t.string('git_branch', 100).defaultTo('main')
    t.string('secret', 64).notNullable()
    t.string('status', 20).defaultTo('offline')
    t.timestamp('last_heartbeat').nullable()
    jsonColumn(t, 'config', '{}', knex)
    t.timestamps(true, true)
  })

  // Developer Runs
  await knex.schema.createTable('developer_runs', (t) => {
    t.string('id', 36).primary()
    t.string('developer_id', 36).references('id').inTable('developers').onDelete('CASCADE').notNullable()
    t.string('mode', 20).defaultTo('implement')
    t.text('instructions').notNullable()
    t.string('status', 20).defaultTo('pending')
    t.string('git_sha_start', 40).nullable()
    t.string('git_sha_end', 40).nullable()
    t.text('response').nullable()
    t.timestamp('started_at').nullable()
    t.timestamp('finished_at').nullable()
    t.text('error_message').nullable()
    t.timestamps(true, true)
    t.index(['developer_id', 'created_at'])
  })

  // Developer Logs
  await knex.schema.createTable('developer_logs', (t) => {
    t.string('id', 36).primary()
    t.string('run_id', 36).references('id').inTable('developer_runs').onDelete('CASCADE').notNullable()
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('event_type', 20).notNullable()
    jsonColumn(t, 'data', '{}', knex)
    t.index(['run_id', 'timestamp'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('developer_logs')
  await knex.schema.dropTableIfExists('developer_runs')
  await knex.schema.dropTableIfExists('developers')
}
