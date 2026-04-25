import type { Knex } from 'knex'

// Retry / continue support for failed dispatches.
//
//   resume_context — stitched failure context (stop_reason, error,
//                    last assistant message) the worker prepends to the
//                    rendered prompt for "continue" runs. Null for normal
//                    or "retry" runs.
//   parent_run_id  — points to the source run a retry/continue was forked
//                    from, so chains stay traceable.
export const up = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.text('resume_context').nullable()
    t.string('parent_run_id', 36)
      .references('id')
      .inTable('developer_runs')
      .onDelete('SET NULL')
      .nullable()
    t.index(['parent_run_id'], 'developer_runs_parent_idx')
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.dropIndex(['parent_run_id'], 'developer_runs_parent_idx')
    t.dropColumn('parent_run_id')
    t.dropColumn('resume_context')
  })
}
