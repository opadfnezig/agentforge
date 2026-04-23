import type { Knex } from 'knex'

export const up = async (knex: Knex) => {
  // Action Chats - per-action chat history
  await knex.schema.createTable('action_chats', (t) => {
    t.string('id', 36).primary()
    t.string('action_id', 36).references('id').inTable('actions').onDelete('CASCADE')
    t.string('role').notNullable() // 'user' | 'assistant'
    t.text('content').notNullable()
    t.timestamp('created_at').defaultTo(knex.fn.now())
    t.index(['action_id', 'created_at'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('action_chats')
}
