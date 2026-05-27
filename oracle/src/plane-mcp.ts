// MCP server exposing a small Plane.so toolset over stdio. Spawned by the
// claude CLI when the oracle is configured with PLANE_BASE_URL +
// PLANE_API_KEY (and optional PLANE_WORKSPACE_SLUG / PLANE_PROJECT_ID
// defaults). The oracle generates an MCP config file pointing here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PlaneClient, PlaneError } from './plane-client.js';

const baseUrl = process.env.PLANE_BASE_URL;
const apiKey = process.env.PLANE_API_KEY;
const defaultWs = process.env.PLANE_WORKSPACE_SLUG;
const defaultProject = process.env.PLANE_PROJECT_ID;

if (!baseUrl) {
  process.stderr.write('plane-mcp: PLANE_BASE_URL is required\n');
  process.exit(2);
}
if (!apiKey) {
  process.stderr.write('plane-mcp: PLANE_API_KEY is required\n');
  process.exit(2);
}

const client = new PlaneClient({ baseUrl, apiKey });
const server = new McpServer({ name: 'plane', version: '0.1.0' });

const resolveWs = (input?: string): string => {
  const v = input ?? defaultWs;
  if (!v) throw new Error('workspace_slug required (no PLANE_WORKSPACE_SLUG default)');
  return v;
};
const resolveProject = (input?: string): string => {
  const v = input ?? defaultProject;
  if (!v) throw new Error('project_id required (no PLANE_PROJECT_ID default)');
  return v;
};

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const run = async (fn: () => Promise<unknown>): Promise<McpToolResult> => {
  try {
    const data = await fn();
    return {
      content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    const detail =
      err instanceof PlaneError ? `${err.message}\n${err.body}` : err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: detail }], isError: true };
  }
};

// Both `.registerTool({ inputSchema })` and the deprecated `.tool(name,
// desc, shape, cb)` overload infer cb args from the schema, and with 8
// tools registered in one file TS hits "Type instantiation is excessively
// deep". This wrapper widens args to `any` so we skip the generic chain
// entirely — schema validation still happens at runtime via the SDK.
type ToolShape = Record<string, z.ZodTypeAny>;
// args is typed loose here — the SDK has already validated against the
// zod shape by the time the handler runs, so the values match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<McpToolResult>;
const tool = (name: string, description: string, shape: ToolShape, handler: ToolHandler): void => {
  (server.tool as unknown as (
    n: string,
    d: string,
    s: ToolShape,
    h: ToolHandler,
  ) => void)(name, description, shape, handler);
};

const workspaceSlug = z.string().optional().describe('Workspace slug. Defaults to PLANE_WORKSPACE_SLUG env if set.');
const projectId = z.string().optional().describe('Project UUID. Defaults to PLANE_PROJECT_ID env if set.');

// Fields valid on both create and update payloads. `name` is intentionally
// omitted here so create can mark it required and update can mark it
// optional without a duplicate-key collision when spread.
const mutableBodyFields = {
  description_html: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  state: z.string().optional().describe('State UUID. Look up via Plane UI.'),
  assignees: z.array(z.string()).optional().describe('Member UUIDs'),
  labels: z.array(z.string()).optional().describe('Label UUIDs'),
  start_date: z.string().optional().describe('ISO date'),
  target_date: z.string().optional().describe('ISO date'),
  estimate_point: z.number().optional(),
};

tool(
  'plane_list_work_items',
  'List work items (tasks) in a Plane project. Cursor-paginated. Default per_page 20, max 100. order_by prefix "-" for descending (e.g. "-created_at").',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    cursor: z.string().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
    order_by: z.string().optional(),
    priority: z.string().optional(),
    state: z.string().optional(),
  },
  async (args) =>
    run(() =>
      client.listWorkItems(resolveWs(args.workspace_slug), resolveProject(args.project_id), {
        cursor: args.cursor,
        per_page: args.per_page,
        order_by: args.order_by,
        priority: args.priority,
        state: args.state,
      }),
    ),
);

tool(
  'plane_get_work_item',
  'Get a single work item by id.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    work_item_id: z.string(),
  },
  async (args) =>
    run(() => client.getWorkItem(resolveWs(args.workspace_slug), resolveProject(args.project_id), args.work_item_id)),
);

tool(
  'plane_create_work_item',
  'Create a new work item. Required: name. Optional: description_html, priority, state UUID, assignees[], labels[], start_date, target_date, estimate_point.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    name: z.string(),
    ...mutableBodyFields,
  },
  async (args) => {
    const { workspace_slug, project_id, ...rest } = args;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) body[k] = v;
    }
    return run(() => client.createWorkItem(resolveWs(workspace_slug), resolveProject(project_id), body));
  },
);

tool(
  'plane_update_work_item',
  'PATCH a work item. Only include the fields you want to change.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    work_item_id: z.string(),
    name: z.string().optional(),
    ...mutableBodyFields,
  },
  async (args) => {
    const { workspace_slug, project_id, work_item_id, ...rest } = args;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) body[k] = v;
    }
    return run(() =>
      client.updateWorkItem(resolveWs(workspace_slug), resolveProject(project_id), work_item_id, body),
    );
  },
);

tool(
  'plane_delete_work_item',
  'Delete a work item. Destructive — confirm with the user before calling unless they explicitly asked.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    work_item_id: z.string(),
  },
  async (args) =>
    run(() =>
      client.deleteWorkItem(resolveWs(args.workspace_slug), resolveProject(args.project_id), args.work_item_id),
    ),
);

tool(
  'plane_list_cycles',
  'List cycles (sprints) in a project. cycle_view filters to current | upcoming | completed | draft. Use "completed" to read previous sprints.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    cycle_view: z.enum(['current', 'upcoming', 'completed', 'draft']).optional(),
    cursor: z.string().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async (args) =>
    run(() =>
      client.listCycles(resolveWs(args.workspace_slug), resolveProject(args.project_id), {
        cycle_view: args.cycle_view,
        cursor: args.cursor,
        per_page: args.per_page,
      }),
    ),
);

tool(
  'plane_get_cycle',
  'Get a single cycle (sprint) by id.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    cycle_id: z.string(),
  },
  async (args) =>
    run(() => client.getCycle(resolveWs(args.workspace_slug), resolveProject(args.project_id), args.cycle_id)),
);

tool(
  'plane_list_cycle_work_items',
  'List the work items inside a specific cycle. Use to inspect a previous sprint contents.',
  {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    cycle_id: z.string(),
    cursor: z.string().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  async (args) =>
    run(() =>
      client.listCycleWorkItems(
        resolveWs(args.workspace_slug),
        resolveProject(args.project_id),
        args.cycle_id,
        { cursor: args.cursor, per_page: args.per_page },
      ),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
