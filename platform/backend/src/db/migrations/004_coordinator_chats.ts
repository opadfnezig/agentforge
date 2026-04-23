import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('coordinator_chats', (t) => {
    t.uuid('id').primary()
    t.string('title', 255).notNullable()
    t.timestamp('created_at').defaultTo(knex.fn.now())
    t.timestamp('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('coordinator_messages', (t) => {
    t.uuid('id').primary()
    t.uuid('chat_id').notNullable().references('id').inTable('coordinator_chats').onDelete('CASCADE')
    t.enum('role', ['user', 'assistant', 'system']).notNullable()
    t.text('content').notNullable()
    t.timestamp('created_at').defaultTo(knex.fn.now())
    t.index('chat_id')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('coordinator_messages')
  await knex.schema.dropTableIfExists('coordinator_chats')
}
