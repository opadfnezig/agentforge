// Oracle engine: thin facade over the OracleRegistry that exposes
// query/merge/migrate operations. Each call creates an oracle_queries row,
// dispatches it to the running oracle worker, and resolves with the worker's
// response. The query row carries the full lifecycle (mode, status, model,
// cost, duration) so the UI can render history identical to developer runs.
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { oracleRegistry } from './oracle-registry.js'
import { OracleMode } from '../schemas/oracle.js'

export const readState = async (stateDir: string): Promise<string> => {
  return oracleQueries.getOracleState(stateDir)
}

interface DispatchResult {
  queryId: string
  response: string
}

/**
 * Internal: drive a single oracle dispatch synchronously. Creates a queued
 * row, fires it via the registry, waits for terminal status, and resolves
 * the assistant text. Throws if the run failed.
 */
const runOracleDispatch = async (
  oracleId: string,
  mode: OracleMode,
  message: string
): Promise<DispatchResult> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  if (!oracleRegistry.isOnline(oracleId)) {
    throw new Error(
      `Oracle "${oracle.domain}" is offline — spawn its container (kind=oracle) before ${mode === 'read' ? 'querying' : mode === 'write' ? 'saving' : 'migrating'}.`
    )
  }

  const query = await oracleQueries.createOracleQuery({
    oracleId,
    mode,
    message,
    status: 'queued',
  })

  // Fire and wait. The registry handles persistence of logs, metadata, and
  // terminal status. We just block on the complete event for the synchronous
  // contract this engine exposes.
  await oracleRegistry.dispatch(oracleId, query.id, mode, message)

  // Re-read terminal state.
  const final = await oracleQueries.getOracleQuery(query.id)
  if (!final) throw new Error('Query disappeared mid-flight')
  if (final.status === 'success') {
    return { queryId: final.id, response: final.response ?? '' }
  }
  throw new Error(final.errorMessage || `Oracle run ended in status ${final.status}`)
}

export const queryOracle = async (
  oracleId: string,
  message: string
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  const startTime = Date.now()
  try {
    const { response } = await runOracleDispatch(oracleId, 'read', message)
    logger.info(
      { oracleId, domain: oracle.domain, durationMs: Date.now() - startTime },
      'Oracle query completed'
    )
    return response
  } catch (err) {
    logger.error(
      { oracleId, domain: oracle.domain, durationMs: Date.now() - startTime, err },
      'Oracle query failed'
    )
    throw err
  }
}

export const mergeIntoState = async (
  oracleId: string,
  newData: string
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle merging new data')
  const { response } = await runOracleDispatch(oracleId, 'write', newData)
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle state updated')
  return response
}

export const migrateData = async (oracleId: string): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle migrating /data')
  const { response } = await runOracleDispatch(oracleId, 'migrate', '')
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle migration complete')
  return response
}
