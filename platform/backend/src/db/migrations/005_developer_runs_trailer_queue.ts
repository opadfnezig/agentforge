import type { Knex } from 'knex'

const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

export const up = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.string('provider', 40).nullable()
    t.string('model', 120).nullable()
    t.string('session_id', 80).nullable()
    t.float('total_cost_usd').nullable()
    t.integer('duration_ms').nullable()
    t.integer('duration_api_ms').nullable()
    t.string('stop_reason', 40).nullable()
    if (isSqlite(knex)) {
      t.text('trailer').nullable()
    } else {
      t.jsonb('trailer').nullable()
    }
  })

  // Index pending-run lookups by developer (for queue pick-next).
  await knex.schema.alterTable('developer_runs', (t) => {
    t.index(['developer_id', 'status', 'created_at'], 'developer_runs_queue_idx')
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.dropIndex(['developer_id', 'status', 'created_at'], 'developer_runs_queue_idx')
  })
  await knex.schema.alterTable('developer_runs', (t) => {
    t.dropColumn('provider')
    t.dropColumn('model')
    t.dropColumn('session_id')
    t.dropColumn('total_cost_usd')
    t.dropColumn('duration_ms')
    t.dropColumn('duration_api_ms')
    t.dropColumn('stop_reason')
    t.dropColumn('trailer')
  })
}
