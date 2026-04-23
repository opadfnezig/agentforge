import { EventEmitter } from 'events'
import { join } from 'path'
import { copyFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { Action } from '../schemas/action.js'
import { Edge } from '../schemas/edge.js'
import { Project } from '../schemas/project.js'
import { ActionRun } from '../schemas/build.js'
import { config } from '../config.js'
import * as projectQueries from '../db/queries/projects.js'
import * as serviceQueries from '../db/queries/services.js'
import * as actionQueries from '../db/queries/actions.js'
import * as buildQueries from '../db/queries/builds.js'
import { runAgent, killAgent } from './agent-runner.js'
import { buildPrompt } from '../utils/prompt-builder.js'
import { logger } from '../utils/logger.js'

interface ExecutionContext {
  buildId: string
  projectId: string
  project: Project
  dag: { actions: Action[]; edges: Edge[] }
  runs: Map<string, ActionRun>
  emitter: EventEmitter
  cancelled: boolean
}

// Store active build emitters
const buildEmitters = new Map<string, EventEmitter>()

export const getBuildEventEmitter = (buildId: string): EventEmitter | null => {
  return buildEmitters.get(buildId) || null
}

export const cancelBuild = async (buildId: string): Promise<void> => {
  const emitter = buildEmitters.get(buildId)
  if (emitter) {
    emitter.emit('cancel')
  }
}

// Helper to find actions with no incoming edges (entry points)
// Used during DAG visualization and validation
export const findStartActions = (dag: { actions: Action[]; edges: Edge[] }): Action[] => {
  const targetIds = new Set(dag.edges.map(e => e.targetActionId))
  return dag.actions.filter(a => !targetIds.has(a.id))
}

// Get workspace directory for an action
const getWorkspaceDir = (project: Project, service: { name: string } | null): string => {
  const projectDir = join(config.DATA_DIR, 'projects', project.slug)
  return service ? join(projectDir, 'services', service.name) : projectDir
}

// Get action directory
const getActionDir = (project: Project, actionId: string): string => {
  return join(config.DATA_DIR, 'projects', project.slug, 'actions', actionId)
}

// Copy completion.md from workspace to action directory with timestamp
const copyCompletionFile = async (
  project: Project,
  service: { name: string } | null,
  actionId: string
): Promise<void> => {
  const workspaceDir = getWorkspaceDir(project, service)
  const completionSrc = join(workspaceDir, 'completion.md')

  if (!existsSync(completionSrc)) {
    return
  }

  const actionDir = getActionDir(project, actionId)
  await mkdir(actionDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const completionDest = join(actionDir, `completion_${timestamp}.md`)

  await copyFile(completionSrc, completionDest)
  logger.info({ actionId, completionDest }, 'Completion file copied')
}

// Write error context to workspace for fixer/router actions
const writeErrorContext = async (
  project: Project,
  service: { name: string } | null,
  errorContext: {
    fromAction: string
    errorMessage: string | null
    logs: unknown[]
  }
): Promise<void> => {
  const workspaceDir = getWorkspaceDir(project, service)
  const contextDir = join(workspaceDir, '.agentforge')
  await mkdir(contextDir, { recursive: true })

  const contextPath = join(contextDir, 'error-context.json')
  await writeFile(contextPath, JSON.stringify(errorContext, null, 2))
  logger.info({ contextPath }, 'Error context written')
}

const getReadyActions = (ctx: ExecutionContext): Action[] => {
  const completedIds = new Set(
    [...ctx.runs.entries()]
      .filter(([_, run]) => run.status === 'success' || run.status === 'failure')
      .map(([id]) => id)
  )

  const runningIds = new Set(
    [...ctx.runs.entries()]
      .filter(([_, run]) => run.status === 'running')
      .map(([id]) => id)
  )

  const pendingIds = new Set(
    [...ctx.runs.entries()]
      .filter(([_, run]) => run.status === 'pending')
      .map(([id]) => id)
  )

  return ctx.dag.actions.filter(action => {
    // Already running or completed
    if (runningIds.has(action.id) || completedIds.has(action.id)) {
      return false
    }

    // Check if all dependencies are met
    const incomingEdges = ctx.dag.edges.filter(e => e.targetActionId === action.id)

    if (incomingEdges.length === 0) {
      // Start node - ready if pending
      return pendingIds.has(action.id)
    }

    // Check if any incoming edge is satisfied
    return incomingEdges.some(edge => {
      const sourceRun = ctx.runs.get(edge.sourceActionId)
      if (!sourceRun) return false

      if (edge.type === 'success' && sourceRun.status === 'success') {
        return true
      }
      if (edge.type === 'failure' && sourceRun.status === 'failure') {
        return true
      }
      return false
    })
  })
}

const executeAction = async (
  ctx: ExecutionContext,
  action: Action
): Promise<void> => {
  if (ctx.cancelled) return

  const run = await buildQueries.createActionRun(action.id, ctx.buildId)
  ctx.runs.set(action.id, run)

  await buildQueries.updateActionRun(run.id, {
    status: 'running',
    startedAt: new Date(),
  })

  ctx.emitter.emit('event', {
    type: 'action:start',
    actionId: action.id,
    runId: run.id,
  })

  const service = action.serviceId
    ? await serviceQueries.getService(ctx.projectId, action.serviceId)
    : null

  // Write error context for fixer/router actions (from previous failures)
  if (action.config._errorContext && (action.type === 'fixer' || action.type === 'router')) {
    await writeErrorContext(ctx.project, service, action.config._errorContext as {
      fromAction: string
      errorMessage: string | null
      logs: unknown[]
    })
  }

  const maxRetries = action.config.maxRetries ?? 0
  let attempt = 0
  let success = false
  let lastError: string | undefined

  while (attempt <= maxRetries && !ctx.cancelled) {
    const promptContent = await buildPrompt(action, service, ctx)

    const result = await runAgent({
      project: ctx.project,
      service,
      action,
      runId: run.id,
      promptContent,
      emitter: ctx.emitter,
    })

    if (result.success) {
      success = true
      break
    }

    lastError = result.errorMessage
    attempt++

    if (attempt <= maxRetries) {
      ctx.emitter.emit('event', {
        type: 'action:retry',
        runId: run.id,
        attempt,
      })
      logger.info({ runId: run.id, attempt }, 'Retrying action')
    }
  }

  // Copy completion.md to action directory
  await copyCompletionFile(ctx.project, service, action.id).catch(err => {
    logger.warn({ err, actionId: action.id }, 'Failed to copy completion file')
  })

  const finalStatus = ctx.cancelled ? 'skipped' : success ? 'success' : 'failure'

  await buildQueries.updateActionRun(run.id, {
    status: finalStatus,
    finishedAt: new Date(),
    errorMessage: lastError || null,
    retryCount: attempt,
  })

  ctx.runs.set(action.id, { ...run, status: finalStatus })

  ctx.emitter.emit('event', {
    type: 'action:complete',
    runId: run.id,
    status: finalStatus,
  })

  // Queue next actions based on result
  if (!ctx.cancelled) {
    const nextEdges = ctx.dag.edges.filter(e => {
      if (e.sourceActionId !== action.id) return false
      if (success && e.type === 'success') return true
      if (!success && e.type === 'failure') return true
      return false
    })

    for (const edge of nextEdges) {
      const targetAction = ctx.dag.actions.find(a => a.id === edge.targetActionId)
      if (targetAction && !ctx.runs.has(targetAction.id)) {
        // Add error context for fixer/router actions
        if (!success && (targetAction.type === 'fixer' || targetAction.type === 'router')) {
          const recentLogs = await buildQueries.getRecentLogs(run.id, 50)
          targetAction.config._errorContext = {
            fromAction: action.id,
            errorMessage: lastError || null,
            logs: recentLogs,
          }
        }
      }
    }
  }
}

export const executeDag = async (
  projectId: string,
  buildId: string
): Promise<void> => {
  const emitter = new EventEmitter()
  buildEmitters.set(buildId, emitter)

  const project = await projectQueries.getProject(projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const dag = await actionQueries.getDag(projectId)

  const ctx: ExecutionContext = {
    buildId,
    projectId,
    project,
    dag,
    runs: new Map(),
    emitter,
    cancelled: false,
  }

  // Handle cancellation
  emitter.on('cancel', () => {
    ctx.cancelled = true
    // Kill all running agents
    ctx.runs.forEach((run, _actionId) => {
      if (run.status === 'running') {
        killAgent(run.id).catch(() => {})
      }
    })
  })

  await buildQueries.updateBuild(buildId, {
    status: 'running',
    startedAt: new Date(),
  })

  try {
    // Initialize all actions as pending
    for (const action of dag.actions) {
      const run = await buildQueries.createActionRun(action.id, buildId)
      ctx.runs.set(action.id, run)
    }

    // Main execution loop
    while (!ctx.cancelled) {
      const readyActions = getReadyActions(ctx)

      if (readyActions.length === 0) {
        // Check if all actions are complete
        const allComplete = [...ctx.runs.values()].every(
          r => r.status === 'success' || r.status === 'failure' || r.status === 'skipped'
        )
        if (allComplete) break

        // Wait a bit and check again
        await new Promise(r => setTimeout(r, 100))
        continue
      }

      // Execute ready actions in parallel
      await Promise.all(
        readyActions.map(action => executeAction(ctx, action))
      )
    }

    // Determine final build status
    const hasFailure = [...ctx.runs.values()].some(r => r.status === 'failure')
    const finalStatus = ctx.cancelled ? 'cancelled' : hasFailure ? 'failure' : 'success'

    await buildQueries.updateBuild(buildId, {
      status: finalStatus,
      finishedAt: new Date(),
    })

    emitter.emit('event', {
      type: 'build:complete',
      buildId,
      status: finalStatus,
    })

    logger.info({ buildId, status: finalStatus }, 'Build completed')
  } catch (error) {
    logger.error({ error, buildId }, 'Build execution error')

    await buildQueries.updateBuild(buildId, {
      status: 'failure',
      finishedAt: new Date(),
    })

    emitter.emit('event', {
      type: 'build:error',
      buildId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  } finally {
    buildEmitters.delete(buildId)
  }
}
