import { logger } from '../utils/logger.js'

interface PlaneConfig {
  apiUrl: string
  apiKey: string
  workspace: string
}

interface PlaneProject {
  id: string
  name: string
  identifier: string
  description: string | null
}

interface PlaneIssue {
  id: string
  name: string
  description: string | null
  priority: string | null
  state: string
  created_at: string
  updated_at: string
}

interface CreateIssueData {
  title: string
  description?: string
  priority?: string
  state?: string
}

export class PlaneClient {
  private apiUrl: string
  private apiKey: string
  private workspace: string

  constructor(config: PlaneConfig) {
    this.apiUrl = config.apiUrl
    this.apiKey = config.apiKey
    this.workspace = config.workspace
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiUrl}/api/v1/workspaces/${this.workspace}${path}`

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      logger.error({ status: response.status, text }, 'Plane API error')
      throw new Error(`Plane API error: ${response.status} - ${text}`)
    }

    return response.json() as Promise<T>
  }

  async listProjects(): Promise<PlaneProject[]> {
    return this.request<PlaneProject[]>('GET', '/projects/')
  }

  async listIssues(projectId: string): Promise<PlaneIssue[]> {
    return this.request<PlaneIssue[]>('GET', `/projects/${projectId}/issues/`)
  }

  async getIssue(projectId: string, issueId: string): Promise<PlaneIssue> {
    return this.request<PlaneIssue>(
      'GET',
      `/projects/${projectId}/issues/${issueId}/`
    )
  }

  async createIssue(
    projectId: string,
    data: CreateIssueData
  ): Promise<PlaneIssue> {
    return this.request<PlaneIssue>(
      'POST',
      `/projects/${projectId}/issues/`,
      {
        name: data.title,
        description_html: data.description || '',
        priority: data.priority,
        state: data.state,
      }
    )
  }

  async updateIssue(
    projectId: string,
    issueId: string,
    data: Partial<CreateIssueData>
  ): Promise<PlaneIssue> {
    const updateData: Record<string, unknown> = {}
    if (data.title) updateData.name = data.title
    if (data.description) updateData.description_html = data.description
    if (data.priority) updateData.priority = data.priority
    if (data.state) updateData.state = data.state

    return this.request<PlaneIssue>(
      'PATCH',
      `/projects/${projectId}/issues/${issueId}/`,
      updateData
    )
  }
}
