import { Router, Request, Response, NextFunction } from 'express'
import { spawnRequestSchema } from '../lib/types.js'
import {
  destroyPrimitive,
  inspectPrimitive,
  listPrimitives,
  spawnPrimitive,
  tailPrimitiveLogs,
  SpawnError,
} from '../services/lifecycle.js'

export const spawnsRouter = Router()

spawnsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = spawnRequestSchema.parse(req.body)
    const state = await spawnPrimitive(body)
    res.status(201).json(state)
  } catch (err) {
    next(err)
  }
})

spawnsRouter.get('/', async (_req, res, next) => {
  try {
    const list = await listPrimitives()
    res.json(list)
  } catch (err) {
    next(err)
  }
})

spawnsRouter.get('/:name', async (req, res, next) => {
  try {
    const result = await inspectPrimitive(req.params.name)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

spawnsRouter.post('/:name/destroy', async (req, res, next) => {
  try {
    const result = await destroyPrimitive(req.params.name)
    res.json({
      ok: true,
      archive_path: result.archivePath,
      archive_bytes: result.bytes,
      compose_rm_code: result.rm.code,
    })
  } catch (err) {
    next(err)
  }
})

spawnsRouter.get('/:name/logs', async (req, res, next) => {
  try {
    const tailRaw = req.query.tail
    const since = (req.query.since as string | undefined) || undefined
    let tail: number | 'all' | undefined
    if (tailRaw === 'all') tail = 'all'
    else if (tailRaw !== undefined) {
      const parsed = parseInt(String(tailRaw), 10)
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new SpawnError(400, '`tail` must be a non-negative integer or "all"', 'BAD_TAIL')
      }
      tail = parsed
    } else {
      tail = 200
    }

    const result = await tailPrimitiveLogs(req.params.name, { tail, since })
    res.json({
      service: req.params.name,
      tail,
      since: since ?? null,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  } catch (err) {
    next(err)
  }
})
