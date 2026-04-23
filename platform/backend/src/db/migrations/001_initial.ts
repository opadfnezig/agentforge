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
  // Projects
  await knex.schema.createTable('projects', (t) => {
    t.string('id', 36).primary()
    t.string('name').notNullable()
    t.string('slug').notNullable().unique()
    t.text('description')
    t.string('status').defaultTo('draft')
    t.text('compose_config')
    t.timestamps(true, true)
  })

  // Services
  await knex.schema.createTable('services', (t) => {
    t.string('id', 36).primary()
    t.string('project_id', 36).references('id').inTable('projects').onDelete('CASCADE')
    t.string('name').notNullable()
    t.string('template')
    t.text('mdspec')
    t.text('openapi_spec')
    t.string('directory')
    t.string('status').defaultTo('pending')
    t.timestamps(true, true)
    t.unique(['project_id', 'name'])
  })

  // Actions
  await knex.schema.createTable('actions', (t) => {
    t.string('id', 36).primary()
    t.string('project_id', 36).references('id').inTable('projects').onDelete('CASCADE')
    t.string('name').notNullable()
    t.string('type')
    t.string('service_id', 36).references('id').inTable('services').onDelete('SET NULL')
    jsonColumn(t, 'config', '{}', knex)
    jsonColumn(t, 'position', '{"x": 0, "y": 0}', knex)
    t.timestamps(true, true)
  })

  // Edges
  await knex.schema.createTable('edges', (t) => {
    t.string('id', 36).primary()
    t.string('project_id', 36).references('id').inTable('projects').onDelete('CASCADE')
    t.string('source_action_id', 36).references('id').inTable('actions').onDelete('CASCADE')
    t.string('target_action_id', 36).references('id').inTable('actions').onDelete('CASCADE')
    t.string('type').defaultTo('success')
    t.timestamps(true, true)
  })

  // Builds
  await knex.schema.createTable('builds', (t) => {
    t.string('id', 36).primary()
    t.string('project_id', 36).references('id').inTable('projects').onDelete('CASCADE')
    t.string('status').defaultTo('pending')
    t.timestamp('started_at')
    t.timestamp('finished_at')
    t.timestamps(true, true)
  })

  // Action Runs
  await knex.schema.createTable('action_runs', (t) => {
    t.string('id', 36).primary()
    t.string('action_id', 36).references('id').inTable('actions').onDelete('CASCADE')
    t.string('build_id', 36).references('id').inTable('builds').onDelete('CASCADE')
    t.string('status').defaultTo('pending')
    t.timestamp('started_at')
    t.timestamp('finished_at')
    t.text('error_message')
    t.integer('retry_count').defaultTo(0)
    t.timestamps(true, true)
  })

  // Agent Logs
  await knex.schema.createTable('agent_logs', (t) => {
    t.string('id', 36).primary()
    t.string('action_run_id', 36).references('id').inTable('action_runs').onDelete('CASCADE')
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('event_type')
    jsonColumn(t, 'data', '{}', knex)
    t.index(['action_run_id', 'timestamp'])
  })

  // File Changes
  await knex.schema.createTable('file_changes', (t) => {
    t.string('id', 36).primary()
    t.string('action_run_id', 36).references('id').inTable('action_runs').onDelete('CASCADE')
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('file_path')
    t.string('change_type')
    t.text('diff')
    t.text('content_snapshot')
    t.index(['action_run_id', 'timestamp'])
  })

  // Tasks (single ad-hoc agent tasks)
  await knex.schema.createTable('tasks', (t) => {
    t.string('id', 36).primary()
    t.string('project_id', 36).references('id').inTable('projects').onDelete('CASCADE')
    t.string('service_id', 36).references('id').inTable('services').onDelete('SET NULL')
    t.text('prompt').notNullable()
    t.string('scope').notNullable()
    jsonColumn(t, 'read_access', '[]', knex)
    jsonColumn(t, 'write_access', '[]', knex)
    t.string('status').defaultTo('pending')
    t.timestamp('started_at')
    t.timestamp('finished_at')
    t.text('error_message')
    t.timestamps(true, true)
  })

  // Task Logs (reusing agent_logs structure)
  await knex.schema.createTable('task_logs', (t) => {
    t.string('id', 36).primary()
    t.string('task_id', 36).references('id').inTable('tasks').onDelete('CASCADE')
    t.timestamp('timestamp').defaultTo(knex.fn.now())
    t.string('event_type')
    jsonColumn(t, 'data', '{}', knex)
    t.index(['task_id', 'timestamp'])
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.dropTableIfExists('task_logs')
  await knex.schema.dropTableIfExists('tasks')
  await knex.schema.dropTableIfExists('file_changes')
  await knex.schema.dropTableIfExists('agent_logs')
  await knex.schema.dropTableIfExists('action_runs')
  await knex.schema.dropTableIfExists('builds')
  await knex.schema.dropTableIfExists('edges')
  await knex.schema.dropTableIfExists('actions')
  await knex.schema.dropTableIfExists('services')
  await knex.schema.dropTableIfExists('projects')
}
