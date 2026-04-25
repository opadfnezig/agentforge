import { appendFileSync } from 'fs'
import { config, paths } from '../config.js'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const enabled = (lvl: Level) => LEVELS[lvl] >= LEVELS[config.NTFR_LOG_LEVEL]

const writeLog = (lvl: Level, msg: string, extra?: unknown) => {
  if (!enabled(lvl)) return
  const ts = new Date().toISOString()
  const base = { ts, level: lvl, msg, ...(extra && typeof extra === 'object' ? extra : extra !== undefined ? { extra } : {}) }
  const line = JSON.stringify(base)
  if (lvl === 'error' || lvl === 'warn') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
  try {
    appendFileSync(paths.spawnerLog, line + '\n')
  } catch {
    // log file not yet ready (during early bootstrap before workdir exists); ignore
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => writeLog('debug', msg, extra),
  info: (msg: string, extra?: unknown) => writeLog('info', msg, extra),
  warn: (msg: string, extra?: unknown) => writeLog('warn', msg, extra),
  error: (msg: string, extra?: unknown) => writeLog('error', msg, extra),
}
