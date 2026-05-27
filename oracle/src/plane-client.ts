// Thin HTTP wrapper around the Plane.so REST API. Self-hosted-friendly:
// the base URL is whatever the operator points us at; we just append
// /api/v1/... under it.

export interface PlaneClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class PlaneError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
    this.name = 'PlaneError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class PlaneClient {
  constructor(private cfg: PlaneClientConfig) {}

  private url(path: string, query?: Query): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/api/v1${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = { 'X-API-Key': this.cfg.apiKey };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PlaneError(
        `Plane ${method} ${path} → ${res.status}`,
        res.status,
        text.slice(0, 2000),
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  // --- work items ---

  listWorkItems(ws: string, pid: string, query: Query = {}): Promise<unknown> {
    return this.request('GET', `/workspaces/${ws}/projects/${pid}/work-items/`, { query });
  }
  getWorkItem(ws: string, pid: string, id: string): Promise<unknown> {
    return this.request('GET', `/workspaces/${ws}/projects/${pid}/work-items/${id}/`);
  }
  createWorkItem(ws: string, pid: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/workspaces/${ws}/projects/${pid}/work-items/`, { body });
  }
  updateWorkItem(ws: string, pid: string, id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/workspaces/${ws}/projects/${pid}/work-items/${id}/`, { body });
  }
  deleteWorkItem(ws: string, pid: string, id: string): Promise<unknown> {
    return this.request('DELETE', `/workspaces/${ws}/projects/${pid}/work-items/${id}/`);
  }

  // --- cycles (sprints) ---

  listCycles(ws: string, pid: string, query: Query = {}): Promise<unknown> {
    return this.request('GET', `/workspaces/${ws}/projects/${pid}/cycles/`, { query });
  }
  getCycle(ws: string, pid: string, cycleId: string): Promise<unknown> {
    return this.request('GET', `/workspaces/${ws}/projects/${pid}/cycles/${cycleId}/`);
  }
  // Plane keeps the legacy "cycle-issues" path even though the entity is
  // now called a work item.
  listCycleWorkItems(ws: string, pid: string, cycleId: string, query: Query = {}): Promise<unknown> {
    return this.request(
      'GET',
      `/workspaces/${ws}/projects/${pid}/cycles/${cycleId}/cycle-issues/`,
      { query },
    );
  }
}
