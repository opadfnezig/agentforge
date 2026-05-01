import type { Knex } from 'knex'

export const up = async (knex: Knex) => {
  await knex.schema.createTable('developer_chats', (t) => {
    t.string('id', 36).primary()
    t.string('developer_id', 36).references('id').inTable('developers').onDelete('CASCADE').notNullable()
    t.string('title', 200).nullable()
    t.string('claude_session_id', 100).nullable()
    t.timestamp('last_message_at').nullable()
    t.timestamps(true, true)
    t.index(['developer_id', 'created_at'])
  })

  await knex.schema.alterTable('developer_runs', (t) => {
    t.string('chat_id', 36).references('id').inTable('developer_chats').onDelete('SET NULL').nullable()
    t.index(['chat_id', 'created_at'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.dropColumn('chat_id')
  })
  await knex.schema.dropTableIfExists('developer_chats')
}
