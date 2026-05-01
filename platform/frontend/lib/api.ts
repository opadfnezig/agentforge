// Server-side: use internal Docker network URL directly
// Client-side: use relative /api which proxies through Next.js
const getApiBase = () => {
  if (typeof window === 'undefined') {
    // Server-side rendering - use internal Docker URL
    // Hardcoded because runtime env vars don't work in Next.js standalone
    return 'http://backend:3001'
  }
  // Client-side - use relative URL (proxied by Next.js API routes)
  return ''
}

interface FetchOptions extends RequestInit {
  params?: Record<string, string>
}

async function fetchAPI<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { params, ...fetchOptions } = options

  const apiBase = getApiBase()
  let url = `${apiBase}/api${endpoint}`
  if (params) {
    const searchParams = new URLSearchParams(params)
    url += `?${searchParams.toString()}`
  }

  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }))
    const err = new Error(error.error?.message || `HTTP ${res.status}`) as Error & {
      status?: number
      code?: string
    }
    err.status = res.status
    err.code = error.error?.code
    throw err
  }

  if (res.status === 204) {
    return undefined as T
  }

  return res.json()
}

// Projects
export const projectsApi = {
  list: () => fetchAPI<Project[]>('/projects'),
  get: (id: string) => fetchAPI<Project>(`/projects/${id}`),
  create: (data: CreateProject) =>
    fetchAPI<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: UpdateProject) =>
    fetchAPI<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => fetchAPI<void>(`/projects/${id}`, { method: 'DELETE' }),
  generateCompose: (id: string) =>
    fetchAPI<Project>(`/projects/${id}/compose`, { method: 'POST' }),
  start: (id: string) => fetchAPI<Project>(`/projects/${id}/start`, { method: 'POST' }),
  stop: (id: string) => fetchAPI<Project>(`/projects/${id}/stop`, { method: 'POST' }),
  rebuild: (id: string) => fetchAPI<Project>(`/projects/${id}/rebuild`, { method: 'POST' }),
}

// Services
export const servicesApi = {
  list: (projectId: string) => fetchAPI<Service[]>(`/projects/${projectId}/services`),
  get: (projectId: string, serviceId: string) =>
    fetchAPI<Service>(`/projects/${projectId}/services/${serviceId}`),
  create: (projectId: string, data: CreateService) =>
    fetchAPI<Service>(`/projects/${projectId}/services`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (projectId: string, serviceId: string, data: UpdateService) =>
    fetchAPI<Service>(`/projects/${projectId}/services/${serviceId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (projectId: string, serviceId: string) =>
    fetchAPI<void>(`/projects/${projectId}/services/${serviceId}`, { method: 'DELETE' }),
  getFiles: (projectId: string, serviceId: string) =>
    fetchAPI<FileInfo[]>(`/projects/${projectId}/services/${serviceId}/files`),
  getFile: (projectId: string, serviceId: string, filePath: string) =>
    fetchAPI<{ path: string; content: string }>(
      `/projects/${projectId}/services/${serviceId}/files/${filePath}`
    ),
}

// Actions & DAG
export const actionsApi = {
  list: (projectId: string) => fetchAPI<Action[]>(`/projects/${projectId}/actions`),
  create: (projectId: string, data: CreateAction) =>
    fetchAPI<Action>(`/projects/${projectId}/actions`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (projectId: string, actionId: string, data: UpdateAction) =>
    fetchAPI<Action>(`/projects/${projectId}/actions/${actionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (projectId: string, actionId: string) =>
    fetchAPI<void>(`/projects/${projectId}/actions/${actionId}`, { method: 'DELETE' }),
  getDag: (projectId: string) =>
    fetchAPI<{ actions: Action[]; edges: Edge[] }>(`/projects/${projectId}/dag`),
  validateDag: (projectId: string) =>
    fetchAPI<DagValidation>(`/projects/${projectId}/dag/validate`, { method: 'POST' }),
}

// Edges
export const edgesApi = {
  create: (projectId: string, data: CreateEdge) =>
    fetchAPI<Edge>(`/projects/${projectId}/edges`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (projectId: string, edgeId: string) =>
    fetchAPI<void>(`/projects/${projectId}/edges/${edgeId}`, { method: 'DELETE' }),
}

// Builds
export const buildsApi = {
  start: (projectId: string) =>
    fetchAPI<Build>(`/projects/${projectId}/build`, { method: 'POST' }),
  get: (projectId: string, buildId: string) =>
    fetchAPI<Build>(`/projects/${projectId}/build/${buildId}`),
  cancel: (projectId: string, buildId: string) =>
    fetchAPI<Build>(`/projects/${projectId}/build/${buildId}/cancel`, { method: 'POST' }),
  getRuns: (projectId: string, buildId: string) =>
    fetchAPI<ActionRun[]>(`/projects/${projectId}/build/${buildId}/runs`),
  getLogs: (projectId: string, buildId: string, runId: string, params?: { limit?: number; offset?: number }) =>
    fetchAPI<AgentLog[]>(`/projects/${projectId}/build/${buildId}/runs/${runId}/logs`, { params: params as Record<string, string> }),
  getFileChanges: (projectId: string, buildId: string, runId: string) =>
    fetchAPI<FileChange[]>(`/projects/${projectId}/build/${buildId}/runs/${runId}/files`),
}

// Tasks
export const tasksApi = {
  create: (projectId: string, data: CreateTask) =>
    fetchAPI<Task>(`/projects/${projectId}/task`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  get: (projectId: string, taskId: string) =>
    fetchAPI<Task>(`/projects/${projectId}/task/${taskId}`),
  getLogs: (projectId: string, taskId: string, params?: { limit?: number; offset?: number }) =>
    fetchAPI<TaskLog[]>(`/projects/${projectId}/task/${taskId}/logs`, { params: params as Record<string, string> }),
}

// Editor
export const editorApi = {
  start: (projectId: string, serviceId?: string) =>
    fetchAPI<{ url: string }>(`/projects/${projectId}/editor`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),
  stop: (projectId: string) =>
    fetchAPI<void>(`/projects/${projectId}/editor`, { method: 'DELETE' }),
  getUrl: (projectId: string) =>
    fetchAPI<{ url: string }>(`/projects/${projectId}/editor/url`),
}

// Action Chat
export const actionChatApi = {
  list: (projectId: string, actionId: string) =>
    fetchAPI<ChatMessage[]>(`/projects/${projectId}/actions/${actionId}/chat`),
  send: (projectId: string, actionId: string, data: CreateChatMessage) =>
    fetchAPI<ChatMessage>(`/projects/${projectId}/actions/${actionId}/chat`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  clear: (projectId: string, actionId: string) =>
    fetchAPI<void>(`/projects/${projectId}/actions/${actionId}/chat`, { method: 'DELETE' }),
}

// Action Files
export const actionFilesApi = {
  list: (projectId: string, actionId: string) =>
    fetchAPI<ActionFile[]>(`/projects/${projectId}/actions/${actionId}/files`),
  get: (projectId: string, actionId: string, filename: string) =>
    fetchAPI<{ name: string; content: string }>(`/projects/${projectId}/actions/${actionId}/files/${filename}`),
  create: (projectId: string, actionId: string, data: { name: string; content: string }) =>
    fetchAPI<{ name: string; content: string }>(`/projects/${projectId}/actions/${actionId}/files`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (projectId: string, actionId: string, filename: string) =>
    fetchAPI<void>(`/projects/${projectId}/actions/${actionId}/files/${filename}`, { method: 'DELETE' }),
}

// Types
interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  status: 'draft' | 'building' | 'ready' | 'error' | 'stopped'
  composeConfig: string | null
  createdAt: string
  updatedAt: string
}

interface CreateProject {
  name: string
  slug?: string
  description?: string
}

interface UpdateProject {
  name?: string
  description?: string | null
  status?: Project['status']
  composeConfig?: string
}

interface Service {
  id: string
  projectId: string
  name: string
  template: 'node' | 'next' | 'python' | 'go' | 'static' | 'database' | 'custom'
  mdspec: string | null
  openapiSpec: string | null
  directory: string
  status: 'pending' | 'building' | 'ready' | 'error'
  createdAt: string
  updatedAt: string
}

interface CreateService {
  name: string
  template: Service['template']
  mdspec?: string
  openapiSpec?: string
}

interface UpdateService {
  name?: string
  template?: Service['template']
  mdspec?: string | null
  openapiSpec?: string | null
  status?: Service['status']
}

interface Action {
  id: string
  projectId: string
  name: string
  type: 'start' | 'end' | 'build' | 'unit-test' | 'api-test' | 'integration-test' | 'e2e-test' | 'fixer' | 'router' | 'custom'
  serviceId: string | null
  mdspec: string | null
  config: Record<string, unknown>
  position: { x: number; y: number }
  createdAt: string
}

interface CreateAction {
  name: string
  type: Action['type']
  serviceId?: string | null
  config?: Record<string, unknown>
  position?: { x: number; y: number }
}

interface UpdateAction {
  name?: string
  type?: Action['type']
  serviceId?: string | null
  mdspec?: string | null
  config?: Record<string, unknown>
  position?: { x: number; y: number }
}

interface Edge {
  id: string
  projectId: string
  sourceActionId: string
  targetActionId: string
  type: 'success' | 'failure'
  createdAt: string
}

interface CreateEdge {
  sourceActionId: string
  targetActionId: string
  type?: 'success' | 'failure'
}

interface DagValidation {
  valid: boolean
  errors: Array<{
    type: string
    message: string
    nodeIds?: string[]
  }>
}

interface Build {
  id: string
  projectId: string
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled'
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

interface ActionRun {
  id: string
  actionId: string
  buildId: string
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped'
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  retryCount: number
  createdAt: string
  updatedAt: string
}

interface AgentLog {
  id: string
  actionRunId: string
  timestamp: string
  eventType: 'init' | 'thinking' | 'tool_use' | 'tool_result' | 'message' | 'error' | 'complete'
  data: Record<string, unknown>
}

interface FileChange {
  id: string
  actionRunId: string
  timestamp: string
  filePath: string
  changeType: 'create' | 'modify' | 'delete'
  diff: string | null
  contentSnapshot: string | null
}

interface FileInfo {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: string
}

interface Task {
  id: string
  projectId: string
  serviceId: string | null
  prompt: string
  scope: 'project' | 'service'
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled'
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

interface CreateTask {
  prompt: string
  scope: 'project' | 'service'
  serviceId?: string
  readAccess?: string[]
  writeAccess?: string[]
}

interface TaskLog {
  id: string
  taskId: string
  timestamp: string
  eventType: string
  data: Record<string, unknown>
}

interface ChatMessage {
  id: string
  actionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

interface CreateChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ActionFile {
  name: string
  isDirectory: boolean
  size: number
  modifiedAt: string
}

// Oracle system types
export interface Scope { id: string; name: string; slug: string; description: string | null; parentId: string | null }
export interface Oracle {
  id: string
  name: string
  domain: string
  scopeId: string | null
  description: string | null
  status: 'active' | 'inactive' | 'error'
  stateDir: string
  config: Record<string, unknown>
  online?: boolean
  createdAt: string
  updatedAt: string
}
export type OracleMode = 'read' | 'write' | 'migrate' | 'chat'
export interface OracleQuery {
  id: string
  oracleId: string
  mode: OracleMode
  message: string
  response: string | null
  status: 'pending' | 'queued' | 'running' | 'success' | 'failure' | 'cancelled'
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  provider: string | null
  model: string | null
  sessionId: string | null
  totalCostUsd: number | null
  durationMs: number | null
  durationApiMs: number | null
  stopReason: string | null
  trailer: Record<string, unknown> | null
  resumeContext: string | null
  parentQueryId: string | null
  chatId: string | null
  createdAt: string
  updatedAt: string
}
export interface OracleChat {
  id: string
  oracleId: string
  title: string | null
  claudeSessionId: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}
export interface OracleLog {
  id: string
  queryId: string
  timestamp: string
  eventType: string
  data: Record<string, unknown>
}
export interface OracleStateFile { name: string; content: string }

// Oracles
export const oraclesApi = {
  list: () => fetchAPI<Oracle[]>('/oracles'),
  get: (id: string) => fetchAPI<Oracle>(`/oracles/${id}`),
  getState: (id: string) => fetchAPI<{ files: OracleStateFile[] }>(`/oracles/${id}/state`),
  // Legacy synchronous query — returns the response after the run finishes.
  // Page UI uses dispatch + stream instead.
  query: (id: string, message: string) =>
    fetchAPI<{ response: string }>(`/oracles/${id}/query`, { method: 'POST', body: JSON.stringify({ message }) }),
  dispatch: (
    id: string,
    message: string,
    opts: { mode?: OracleMode; autoApprove?: boolean; chatId?: string } = {}
  ) =>
    fetchAPI<{ queryId: string; status: OracleQuery['status']; mode: OracleMode; pending: boolean; chatId: string | null }>(
      `/oracles/${id}/dispatch`,
      { method: 'POST', body: JSON.stringify({ message, mode: opts.mode ?? 'read', autoApprove: opts.autoApprove ?? true, chatId: opts.chatId }) }
    ),
  // Chats
  createChat: (id: string, title?: string) =>
    fetchAPI<OracleChat>(`/oracles/${id}/chats`, { method: 'POST', body: JSON.stringify({ title }) }),
  promoteQueryToChat: (id: string, queryId: string) =>
    fetchAPI<OracleChat>(`/oracles/${id}/queries/${queryId}/promote-to-chat`, { method: 'POST' }),
  listChats: (id: string) => fetchAPI<OracleChat[]>(`/oracles/${id}/chats`),
  getChat: (id: string, chatId: string) =>
    fetchAPI<{ chat: OracleChat; messages: OracleQuery[] }>(`/oracles/${id}/chats/${chatId}`),
  updateChatTitle: (id: string, chatId: string, title: string | null) =>
    fetchAPI<OracleChat>(`/oracles/${id}/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string, chatId: string) =>
    fetchAPI<void>(`/oracles/${id}/chats/${chatId}`, { method: 'DELETE' }),
  approveQuery: (id: string, queryId: string) =>
    fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}/approve`, { method: 'POST' }),
  cancelQuery: (id: string, queryId: string) =>
    fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}/cancel`, { method: 'POST' }),
  retryQuery: (id: string, queryId: string) =>
    fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}/retry`, { method: 'POST' }),
  continueQuery: (id: string, queryId: string) =>
    fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}/continue`, { method: 'POST' }),
  editQueryMessage: (id: string, queryId: string, message: string) =>
    fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}`, { method: 'PATCH', body: JSON.stringify({ message }) }),
  listQueries: (id: string) => fetchAPI<OracleQuery[]>(`/oracles/${id}/queries`),
  getQuery: (id: string, queryId: string) => fetchAPI<OracleQuery>(`/oracles/${id}/queries/${queryId}`),
  listLogs: (id: string, queryId: string) => fetchAPI<OracleLog[]>(`/oracles/${id}/queries/${queryId}/logs`),
  listQueue: (id: string) => fetchAPI<OracleQuery[]>(`/oracles/${id}/queue`),
  getQueries: (id: string) => fetchAPI<OracleQuery[]>(`/oracles/${id}/queries`),
}

// Developer system types
export interface Developer {
  id: string
  name: string
  scopeId: string | null
  workspacePath: string
  gitRepo: string | null
  gitBranch: string
  status: 'offline' | 'idle' | 'busy' | 'error'
  lastHeartbeat: string | null
  config: Record<string, unknown>
  online: boolean
  createdAt: string
  updatedAt: string
}

export type DeveloperRunMode = 'implement' | 'clarify' | 'chat'

export interface DeveloperRun {
  id: string
  developerId: string
  mode: DeveloperRunMode
  instructions: string
  status: 'pending' | 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'no_changes'
  gitShaStart: string | null
  gitShaEnd: string | null
  response: string | null
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  provider: string | null
  model: string | null
  sessionId: string | null
  totalCostUsd: number | null
  durationMs: number | null
  durationApiMs: number | null
  stopReason: string | null
  trailer: Record<string, unknown> | null
  pushStatus: 'pushed' | 'failed' | 'not_attempted' | null
  pushError: string | null
  resumeContext: string | null
  parentRunId: string | null
  chatId: string | null
  createdAt: string
}

export interface DeveloperLog {
  id: string
  runId: string
  timestamp: string
  eventType: string
  data: Record<string, unknown>
}

export interface DeveloperChat {
  id: string
  developerId: string
  title: string | null
  claudeSessionId: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeveloperStateFile { name: string; content: string }

// Spawner hosts
// -----------------------------------------------------------------------------
// Backend surface lives at /api/spawners. Spawn intents (the approval queue
// for [spawn, ...] coordinator commands) live at
// /api/spawners/:id/spawn-intents/:intentId.

export type PrimitiveKind = 'developer' | 'researcher'
export type PrimitiveState =
  | 'creating'
  | 'running'
  | 'crashed'
  | 'destroyed'
  | 'orphaned'

export interface SpawnerHost {
  id: string
  hostId: string
  name: string
  baseUrl: string
  status: 'unknown' | 'online' | 'offline' | 'error'
  version: string | null
  capabilities: string[]
  lastSeenAt: string | null
  lastEventAt: string | null
  lastError: string | null
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CreateSpawnerHost {
  hostId: string
  name: string
  baseUrl: string
  config?: Record<string, unknown>
}

export interface UpdateSpawnerHost {
  name?: string
  baseUrl?: string
  config?: Record<string, unknown>
}

export interface Spawn {
  id: string
  spawnerHostId: string
  primitiveName: string
  primitiveKind: PrimitiveKind
  state: PrimitiveState
  prevState: PrimitiveState | null
  lastEventId: string | null
  lastEventAt: string
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface SpawnIntent {
  id: string
  spawnerHostId: string
  primitiveName: string
  primitiveKind: PrimitiveKind
  image: string
  spec: Record<string, unknown>
  status: 'pending' | 'approved' | 'cancelled' | 'failed'
  errorMessage: string | null
  approvedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ApproveSpawnResult {
  intent: SpawnIntent
  primitive: {
    name: string
    kind: string
    state: string
    image: string
    container_id: string | null
    created_at: string
    updated_at: string
    last_event_at: string | null
    last_event_id: string | null
    spec: Record<string, unknown>
  }
}

export type ProbeResult =
  | { status: 'online'; version: string; capabilities: string[]; primitiveCount: number; latencyMs: number }
  | { status: 'offline'; reason: string }
  | { status: 'error'; httpStatus: number; reason: string }

export const spawnersApi = {
  list: () => fetchAPI<SpawnerHost[]>('/spawners'),
  get: (id: string) => fetchAPI<SpawnerHost>(`/spawners/${id}`),
  create: (data: CreateSpawnerHost) =>
    fetchAPI<SpawnerHost>('/spawners', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: UpdateSpawnerHost) =>
    fetchAPI<SpawnerHost>(`/spawners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => fetchAPI<void>(`/spawners/${id}`, { method: 'DELETE' }),
  probe: (id: string) => fetchAPI<ProbeResult>(`/spawners/${id}/probe`, { method: 'POST' }),
  listSpawns: (id: string) => fetchAPI<Spawn[]>(`/spawners/${id}/spawns`),
  getSpawn: (id: string, primitiveName: string) =>
    fetchAPI<Spawn>(`/spawners/${id}/spawns/${primitiveName}`),
  listIntents: (id: string, status?: SpawnIntent['status']) =>
    fetchAPI<SpawnIntent[]>(
      `/spawners/${id}/spawn-intents${status ? `?status=${status}` : ''}`
    ),
  getIntent: (id: string, intentId: string) =>
    fetchAPI<SpawnIntent>(`/spawners/${id}/spawn-intents/${intentId}`),
  approveSpawn: (id: string, spawnIntentId: string) =>
    fetchAPI<ApproveSpawnResult>(
      `/spawners/${id}/spawn-intents/${spawnIntentId}/approve`,
      { method: 'POST' }
    ),
  cancelSpawn: (id: string, spawnIntentId: string) =>
    fetchAPI<SpawnIntent>(
      `/spawners/${id}/spawn-intents/${spawnIntentId}/cancel`,
      { method: 'POST' }
    ),
}

// Developers
export const developersApi = {
  list: () => fetchAPI<Developer[]>('/developers'),
  get: (id: string) => fetchAPI<Developer>(`/developers/${id}`),
  create: (data: {name: string, workspacePath: string, gitRepo?: string, gitBranch?: string}) =>
    fetchAPI<Developer & {secret: string}>('/developers', {method: 'POST', body: JSON.stringify(data)}),
  delete: (id: string) => fetchAPI<void>(`/developers/${id}`, {method: 'DELETE'}),
  regenerateSecret: (id: string) => fetchAPI<{secret: string}>(`/developers/${id}/secret`, {method: 'POST'}),
  dispatch: (
    id: string,
    instructions: string,
    opts: { mode?: DeveloperRunMode; autoApprove?: boolean; chatId?: string } = {}
  ) =>
    fetchAPI<{runId: string; status: DeveloperRun['status']; queued: boolean; pending: boolean}>(
      `/developers/${id}/dispatch`,
      { method: 'POST', body: JSON.stringify({ instructions, mode: opts.mode ?? 'implement', autoApprove: opts.autoApprove ?? true, chatId: opts.chatId }) }
    ),
  approveRun: (id: string, runId: string) =>
    fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}/approve`, {method: 'POST'}),
  cancelRun: (id: string, runId: string) =>
    fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}/cancel`, {method: 'POST'}),
  retryRun: (id: string, runId: string) =>
    fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}/retry`, {method: 'POST'}),
  continueRun: (id: string, runId: string) =>
    fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}/continue`, {method: 'POST'}),
  editRunInstructions: (id: string, runId: string, instructions: string) =>
    fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}`, {method: 'PATCH', body: JSON.stringify({instructions})}),
  listRuns: (id: string) => fetchAPI<DeveloperRun[]>(`/developers/${id}/runs`),
  getRun: (id: string, runId: string) => fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}`),
  listLogs: (id: string, runId: string) => fetchAPI<DeveloperLog[]>(`/developers/${id}/runs/${runId}/logs`),
  listQueue: (id: string) => fetchAPI<DeveloperRun[]>(`/developers/${id}/queue`),
  // Chats
  createChat: (id: string, title?: string) =>
    fetchAPI<DeveloperChat>(`/developers/${id}/chats`, { method: 'POST', body: JSON.stringify({ title }) }),
  promoteRunToChat: (id: string, runId: string) =>
    fetchAPI<DeveloperChat>(`/developers/${id}/runs/${runId}/promote-to-chat`, { method: 'POST' }),
  listChats: (id: string) => fetchAPI<DeveloperChat[]>(`/developers/${id}/chats`),
  getChat: (id: string, chatId: string) =>
    fetchAPI<{ chat: DeveloperChat; messages: DeveloperRun[] }>(`/developers/${id}/chats/${chatId}`),
  updateChatTitle: (id: string, chatId: string, title: string | null) =>
    fetchAPI<DeveloperChat>(`/developers/${id}/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string, chatId: string) =>
    fetchAPI<void>(`/developers/${id}/chats/${chatId}`, { method: 'DELETE' }),
  // Memory state files
  getState: (id: string) => fetchAPI<{ files: DeveloperStateFile[] }>(`/developers/${id}/state`),
}

// Researchers
export interface Researcher {
  id: string
  name: string
  scopeId: string | null
  status: 'offline' | 'idle' | 'busy' | 'error' | 'destroyed'
  lastHeartbeat: string | null
  config: Record<string, unknown>
  online?: boolean
  createdAt: string
  updatedAt: string
}

export interface ResearcherRun {
  id: string
  researcherId: string
  instructions: string
  status: 'pending' | 'queued' | 'running' | 'success' | 'failure' | 'cancelled'
  response: string | null
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  provider: string | null
  model: string | null
  sessionId: string | null
  totalCostUsd: number | null
  durationMs: number | null
  durationApiMs: number | null
  stopReason: string | null
  trailer: Record<string, unknown> | null
  resumeContext: string | null
  parentRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface ResearcherLog {
  id: string
  runId: string
  timestamp: string
  eventType: string
  data: Record<string, unknown>
}

export const researchersApi = {
  list: () => fetchAPI<Researcher[]>('/researchers'),
  get: (id: string) => fetchAPI<Researcher>(`/researchers/${id}`),
  create: (data: {name: string}) =>
    fetchAPI<Researcher & {secret: string}>('/researchers', {method: 'POST', body: JSON.stringify(data)}),
  delete: (id: string) => fetchAPI<void>(`/researchers/${id}`, {method: 'DELETE'}),
  regenerateSecret: (id: string) => fetchAPI<{secret: string}>(`/researchers/${id}/secret`, {method: 'POST'}),
  dispatch: (id: string, instructions: string, autoApprove = true) =>
    fetchAPI<{runId: string; status: ResearcherRun['status']; queued: boolean; pending: boolean}>(`/researchers/${id}/dispatch`, {method: 'POST', body: JSON.stringify({instructions, autoApprove})}),
  approveRun: (id: string, runId: string) =>
    fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}/approve`, {method: 'POST'}),
  cancelRun: (id: string, runId: string) =>
    fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}/cancel`, {method: 'POST'}),
  retryRun: (id: string, runId: string) =>
    fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}/retry`, {method: 'POST'}),
  continueRun: (id: string, runId: string) =>
    fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}/continue`, {method: 'POST'}),
  editRunInstructions: (id: string, runId: string, instructions: string) =>
    fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}`, {method: 'PATCH', body: JSON.stringify({instructions})}),
  listRuns: (id: string) => fetchAPI<ResearcherRun[]>(`/researchers/${id}/runs`),
  getRun: (id: string, runId: string) => fetchAPI<ResearcherRun>(`/researchers/${id}/runs/${runId}`),
  listLogs: (id: string, runId: string) => fetchAPI<ResearcherLog[]>(`/researchers/${id}/runs/${runId}/logs`),
  listQueue: (id: string) => fetchAPI<ResearcherRun[]>(`/researchers/${id}/queue`),
}

export type {
  Project,
  CreateProject,
  UpdateProject,
  Service,
  CreateService,
  UpdateService,
  Action,
  CreateAction,
  UpdateAction,
  Edge,
  CreateEdge,
  DagValidation,
  Build,
  ActionRun,
  AgentLog,
  FileChange,
  FileInfo,
  Task,
  CreateTask,
  TaskLog,
  ChatMessage,
  CreateChatMessage,
  ActionFile,
}
