import type { Knex } from 'knex'

const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

const jsonColumn = (t: Knex.CreateTableBuilder | Knex.AlterTableBuilder, name: string, defaultVal: string, knex: Knex) => {
  if (isSqlite(knex)) {
    t.text(name).defaultTo(defaultVal)
  } else {
    t.jsonb(name).defaultTo(defaultVal)
  }
}

export const up = async (knex: Knex) => {
  // Extend oracle_queries with run-style metadata. The table has been used
  // as a thin Q&A history; we promote it to a full run record so the UI can
  // show cost/duration/stop_reason/model the same way developer runs do.
  await knex.schema.alterTable('oracle_queries', (t) => {
    t.string('mode', 20).defaultTo('read')
    t.string('provider', 50).nullable()
    t.string('model', 100).nullable()
    t.string('session_id', 100).nullable()
    t.float('total_cost_usd').nullable()
    t.integer('duration_api_ms').nullable()
    t.string('stop_reason', 50).nullable()
    if (isSqlite(knex)) {
      t.text('trailer').defaultTo(null)
    } else {
      t.jsonb('trailer').defaultTo(null)
    }
    t.timestamp('started_at').nullable()
    t.timestamp('finished_at').nullable()
    t.text('error_message').nullable()
    t.text('resume_context').nullable()
    t.string('parent_query_id', 36).nullable()
  })

  // Logs table — mirrors developer_logs. Every Claude event the worker
  // streams over WS lands here so the UI can replay/tail them.
  await knex.schema.createTable('oracle_logs', (t) => {
    t.string('id', 36).primary()
    t.string('query_id', 36).references('id').inTable('oracle_queries').onDelete('CASCADE').notNullable()
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('event_type', 20).notNullable()
    jsonColumn(t, 'data', '{}', knex)
    t.index(['query_id', 'timestamp'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('oracle_logs')
  await knex.schema.alterTable('oracle_queries', (t) => {
    t.dropColumn('mode')
    t.dropColumn('provider')
    t.dropColumn('model')
    t.dropColumn('session_id')
    t.dropColumn('total_cost_usd')
    t.dropColumn('duration_api_ms')
    t.dropColumn('stop_reason')
    t.dropColumn('trailer')
    t.dropColumn('started_at')
    t.dropColumn('finished_at')
    t.dropColumn('error_message')
    t.dropColumn('resume_context')
    t.dropColumn('parent_query_id')
  })
}
