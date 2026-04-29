// Thin shim: existing callers (`queryOracle`, `mergeIntoState`) keep their
// signatures, but execution is routed to the containerized oracle primitive
// over WebSocket via OracleRegistry. The previous in-process `claude` spawn
// has been deleted — when the oracle's container isn't online, calls fail
// with a clear error rather than silently falling back.
//
// Container lifecycle is owned by the spawner (kind=oracle); see
// spawners-routes.ts approval flow for credential injection.
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { oracleRegistry } from './oracle-registry.js'

export const readState = async (stateDir: string): Promise<string> => {
  return oracleQueries.getOracleState(stateDir)
}

export const queryOracle = async (
  oracleId: string,
  message: string,
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  if (!oracleRegistry.isOnline(oracleId)) {
    throw new Error(
      `Oracle "${oracle.domain}" is offline — spawn its container (kind=oracle) before querying.`,
    )
  }
  const startTime = Date.now()
  try {
    const { response, durationMs } = await oracleRegistry.dispatch(oracleId, 'read', message)
    logger.info({ oracleId, domain: oracle.domain, durationMs }, 'Oracle query completed')
    return response
  } catch (err) {
    const durationMs = Date.now() - startTime
    logger.error({ oracleId, domain: oracle.domain, durationMs, err }, 'Oracle query failed')
    throw err
  }
}

export const mergeIntoState = async (
  oracleId: string,
  newData: string,
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  if (!oracleRegistry.isOnline(oracleId)) {
    throw new Error(
      `Oracle "${oracle.domain}" is offline — spawn its container (kind=oracle) before saving.`,
    )
  }
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle merging new data')
  const { response } = await oracleRegistry.dispatch(oracleId, 'write', newData)
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle state updated')
  return response
}

// New: drive the oracle's migrate mode. Used when staged files exist under
// the oracle's mounted /data dir and the operator wants the agent to fold
// them into its memories.
export const migrateData = async (oracleId: string): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)
  if (!oracleRegistry.isOnline(oracleId)) {
    throw new Error(
      `Oracle "${oracle.domain}" is offline — spawn its container (kind=oracle) before migrating.`,
    )
  }
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle migrating /data')
  const { response } = await oracleRegistry.dispatch(oracleId, 'migrate', '')
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle migration complete')
  return response
}
