import type { Knex } from 'knex'

// Split the old 'pending' status into two states:
//
//   'pending' — awaiting user approval (new, coordinator-initiated dispatches)
//   'queued'  — approved / direct dispatch, waiting for an idle developer
//
// Any existing rows with status='pending' predate the approval flow and were
// effectively queued already — promote them so the queue picker still sees
// them.
export const up = async (knex: Knex) => {
  await knex('developer_runs').where({ status: 'pending' }).update({ status: 'queued' })
}

export const down = async (knex: Knex) => {
  await knex('developer_runs').where({ status: 'queued' }).update({ status: 'pending' })
}
