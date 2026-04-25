import type { Knex } from 'knex'

const isSqlite = (knex: Knex) => knex.client.config.client === 'sqlite3'

// Per-message cost/duration capture for the coordinator, plus per-chat
// rolling aggregates. Mirrors the trailer shape we already capture on
// developer_runs (migration 005) so dashboards can read both surfaces with
// the same column conventions.
//
// Note: the dispatch wrote "coordinator_chat_messages" but the table was
// created as "coordinator_messages" in migration 004. We extend the actual
// existing table.
export const up = async (knex: Knex) => {
  await knex.schema.alterTable('coordinator_messages', (t) => {
    t.string('provider', 40).nullable()
    t.string('model', 120).nullable()
    t.float('total_cost_usd').nullable()
    t.integer('duration_ms').nullable()
    t.string('stop_reason', 40).nullable()
    if (isSqlite(knex)) {
      t.text('trailer').nullable()
    } else {
      t.jsonb('trailer').nullable()
    }
  })

  await knex.schema.alterTable('coordinator_chats', (t) => {
    t.float('total_cost_usd').notNullable().defaultTo(0)
    t.bigInteger('total_duration_ms').notNullable().defaultTo(0)
    t.integer('billed_message_count').notNullable().defaultTo(0)
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('coordinator_messages', (t) => {
    t.dropColumn('provider')
    t.dropColumn('model')
    t.dropColumn('total_cost_usd')
    t.dropColumn('duration_ms')
    t.dropColumn('stop_reason')
    t.dropColumn('trailer')
  })
  await knex.schema.alterTable('coordinator_chats', (t) => {
    t.dropColumn('total_cost_usd')
    t.dropColumn('total_duration_ms')
    t.dropColumn('billed_message_count')
  })
}
