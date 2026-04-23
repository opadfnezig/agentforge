import type { Knex } from 'knex'

// Split push outcome from overall run status. Prior behaviour marked a
// run 'failure' when git commit/push failed — even though the agent's
// work had landed in the working tree — which misrepresented the run.
//
//   status:       'pending'|'running'|'success'|'failure'|'cancelled'|'no_changes'
//                 → success means the agent finished its work
//   push_status:  'pushed'|'failed'|'not_attempted' — orthogonal signal
//   push_error:   error text when push_status = 'failed'
export const up = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.string('push_status', 20).nullable()
    t.text('push_error').nullable()
  })
}

export const down = async (knex: Knex) => {
  await knex.schema.alterTable('developer_runs', (t) => {
    t.dropColumn('push_status')
    t.dropColumn('push_error')
  })
}
