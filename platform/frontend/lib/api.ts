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
    throw new Error(error.error?.message || `HTTP ${res.status}`)
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
export interface Oracle { id: string; name: string; slug: string; domain: string; scopeId: string | null; variant: string; status: string; stateDir: string; systemPrompt: string | null; config: Record<string,unknown> }
export interface OracleQuery { id: string; oracleId: string; role: string; content: string; stateDiff: string | null; createdAt: string }
export interface OracleStateFile { name: string; content: string }

// Oracles
export const oraclesApi = {
  list: () => fetchAPI<Oracle[]>('/oracles'),
  get: (id: string) => fetchAPI<Oracle>(`/oracles/${id}`),
  getState: (id: string) => fetchAPI<{files: OracleStateFile[]}>(`/oracles/${id}/state`),
  query: (id: string, message: string) => fetchAPI<{response: string}>(`/oracles/${id}/query`, {method:'POST', body: JSON.stringify({message})}),
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

export interface DeveloperRun {
  id: string
  developerId: string
  mode: 'implement' | 'clarify'
  instructions: string
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'no_changes'
  gitShaStart: string | null
  gitShaEnd: string | null
  response: string | null
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  createdAt: string
}

export interface DeveloperLog {
  id: string
  runId: string
  timestamp: string
  eventType: string
  data: Record<string, unknown>
}

// Developers
export const developersApi = {
  list: () => fetchAPI<Developer[]>('/developers'),
  get: (id: string) => fetchAPI<Developer>(`/developers/${id}`),
  create: (data: {name: string, workspacePath: string, gitRepo?: string, gitBranch?: string}) =>
    fetchAPI<Developer & {secret: string}>('/developers', {method: 'POST', body: JSON.stringify(data)}),
  delete: (id: string) => fetchAPI<void>(`/developers/${id}`, {method: 'DELETE'}),
  regenerateSecret: (id: string) => fetchAPI<{secret: string}>(`/developers/${id}/secret`, {method: 'POST'}),
  dispatch: (id: string, instructions: string, mode: 'implement' | 'clarify' = 'implement') =>
    fetchAPI<{runId: string}>(`/developers/${id}/dispatch`, {method: 'POST', body: JSON.stringify({instructions, mode})}),
  listRuns: (id: string) => fetchAPI<DeveloperRun[]>(`/developers/${id}/runs`),
  getRun: (id: string, runId: string) => fetchAPI<DeveloperRun>(`/developers/${id}/runs/${runId}`),
  listLogs: (id: string, runId: string) => fetchAPI<DeveloperLog[]>(`/developers/${id}/runs/${runId}/logs`),
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
