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
  await knex.schema.createTable('researchers', (t) => {
    t.string('id', 36).primary()
    t.string('name', 100).notNullable()
    t.string('scope_id', 36).references('id').inTable('scopes').onDelete('SET NULL').nullable()
    t.string('secret', 64).notNullable()
    t.string('status', 20).defaultTo('offline')
    t.timestamp('last_heartbeat').nullable()
    jsonColumn(t, 'config', '{}', knex)
    t.timestamps(true, true)
  })

  await knex.schema.createTable('researcher_runs', (t) => {
    t.string('id', 36).primary()
    t.string('researcher_id', 36).references('id').inTable('researchers').onDelete('CASCADE').notNullable()
    t.text('instructions').notNullable()
    t.string('status', 20).defaultTo('pending')
    t.text('response').nullable()
    t.timestamp('started_at').nullable()
    t.timestamp('finished_at').nullable()
    t.text('error_message').nullable()
    t.string('provider', 50).nullable()
    t.string('model', 100).nullable()
    t.string('session_id', 100).nullable()
    t.float('total_cost_usd').nullable()
    t.integer('duration_ms').nullable()
    t.integer('duration_api_ms').nullable()
    t.string('stop_reason', 50).nullable()
    jsonColumn(t, 'trailer', 'null', knex)
    t.text('resume_context').nullable()
    t.string('parent_run_id', 36).references('id').inTable('researcher_runs').onDelete('SET NULL').nullable()
    t.timestamps(true, true)
    t.index(['researcher_id', 'created_at'])
  })

  await knex.schema.createTable('researcher_logs', (t) => {
    t.string('id', 36).primary()
    t.string('run_id', 36).references('id').inTable('researcher_runs').onDelete('CASCADE').notNullable()
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('event_type', 20).notNullable()
    jsonColumn(t, 'data', '{}', knex)
    t.index(['run_id', 'timestamp'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('researcher_logs')
  await knex.schema.dropTableIfExists('researcher_runs')
  await knex.schema.dropTableIfExists('researchers')
}
