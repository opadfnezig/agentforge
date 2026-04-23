# AgentForge Debugging Session - 2025-12-31

## Initial Problem
- POST requests to `/api/projects` returning 500 errors when accessed from remote host (172.16.5.10), not localhost

## Issues Fixed

### 1. CORS Configuration
- **Problem**: `FRONTEND_URL` was set to `http://localhost:3000` but user accessing from `172.16.5.10`
- **Fix**: Updated `.env` and `docker-compose.yml` to use `http://172.16.5.10:3000`

### 2. Database Migrations Not Running
- **Problem**: Backend Dockerfile said "migrations run separately" - tables didn't exist
- **Fix**: Updated `platform/backend/Dockerfile` CMD to run migrations on startup:
  ```dockerfile
  CMD ["sh", "-c", "npx knex migrate:latest --knexfile knexfile.cjs && npm start"]
  ```

### 3. Knexfile TypeScript Error
- **Problem**: Knex trying to load `knexfile.ts` instead of `knexfile.cjs` in production
- **Fix**: Added `RUN rm -f knexfile.ts` to Dockerfile to remove TS version

### 4. Frontend SSR Connection Issues
- **Problem**: Next.js SSR couldn't connect to backend - relative URLs don't work in SSR
- **Fix**: Updated `platform/frontend/lib/api.ts` to use different URLs for server vs client:
  ```typescript
  const getApiBase = () => {
    if (typeof window === 'undefined') {
      return 'http://backend:3001'  // Docker internal URL for SSR
    }
    return ''  // Relative URL for client-side
  }
  ```

### 5. Hardcoded localhost URLs in Pages
- **Problem**: `app/page.tsx` and `app/projects/[id]/page.tsx` had hardcoded `http://localhost:3001`
- **Fix**: Changed to `http://backend:3001` for Docker internal networking

### 6. Next.js API Proxy Route
- **Problem**: Next.js rewrites don't work properly in standalone mode
- **Fix**: Created `app/api/[...path]/route.ts` to proxy client requests to backend

### 7. Edge Creation Routing Bug
- **Problem**: `/api/projects/:projectId/edges` was hitting action creation route (400 error)
- **Fix**: Created separate `platform/backend/src/routes/edges.ts` router

### 8. DAG Route Bug
- **Problem**: `/api/projects/:projectId/dag` was returning action list instead of DAG
- **Fix**: Created separate `platform/backend/src/routes/dag.ts` router

### 9. Start/End Nodes Backend Support
- **Problem**: Start/End nodes were client-side only, not persisted
- **Fix**: Added `'start'` and `'end'` to action types in `platform/backend/src/schemas/action.ts`

### 10. Right-Click Delete for Nodes/Edges
- **Problem**: User wanted right-click to delete nodes and edges
- **Fix**: Added `onNodeContextMenu` and `onEdgeContextMenu` handlers in DAG page

## Files Modified

### Backend
- `/home/user/agentforge/docker-compose.yml` - CORS URLs, build args
- `/home/user/agentforge/.env` - FRONTEND_URL
- `/home/user/agentforge/platform/backend/Dockerfile` - migrations, remove knexfile.ts
- `/home/user/agentforge/platform/backend/src/index.ts` - new routers
- `/home/user/agentforge/platform/backend/src/schemas/action.ts` - added start/end types
- `/home/user/agentforge/platform/backend/src/routes/edges.ts` - NEW FILE
- `/home/user/agentforge/platform/backend/src/routes/dag.ts` - NEW FILE

### Frontend
- `/home/user/agentforge/platform/frontend/lib/api.ts` - SSR URL handling
- `/home/user/agentforge/platform/frontend/app/page.tsx` - backend URL
- `/home/user/agentforge/platform/frontend/app/projects/[id]/page.tsx` - backend URL
- `/home/user/agentforge/platform/frontend/app/projects/[id]/dag/page.tsx` - right-click delete, persistence
- `/home/user/agentforge/platform/frontend/app/api/[...path]/route.ts` - NEW FILE (API proxy)
- `/home/user/agentforge/platform/frontend/next.config.js` - removed rewrites
- `/home/user/agentforge/platform/frontend/components/dag/DeletableEdge.tsx` - NEW FILE (unused now)

## Current State
- Backend should be working with proper routing
- Frontend needs rebuild after all changes
- DAG editor should support:
  - Creating Start/End nodes (persisted to backend)
  - Creating edges between any nodes (persisted)
  - Right-click on node to delete
  - Right-click on edge to delete
  - Persistence across page reloads

## To Test After Rebuild

```bash
# Rebuild
docker compose up -d --build backend frontend

# Test DAG endpoint
curl -s "http://172.16.5.10:3001/api/projects/<project-id>/dag"

# Test create action
curl -s -X POST "http://172.16.5.10:3001/api/projects/<project-id>/actions" \
  -H "Content-Type: application/json" \
  -d '{"name":"Start","type":"start","position":{"x":250,"y":50}}'

# Test create edge
curl -s -X POST "http://172.16.5.10:3001/api/projects/<project-id>/edges" \
  -H "Content-Type: application/json" \
  -d '{"sourceActionId":"<uuid>","targetActionId":"<uuid>","type":"success"}'

# Test delete action
curl -s -X DELETE "http://172.16.5.10:3001/api/projects/<project-id>/actions/<action-id>"

# Test delete edge
curl -s -X DELETE "http://172.16.5.10:3001/api/projects/<project-id>/edges/<edge-id>"
```

## Session 2 - 2025-12-31 (Rebuild & Test)

### Issues Fixed

#### 11. TypeScript Unused Import
- **Problem**: `src/routes/dag.ts` had unused `logger` import causing build failure
- **Fix**: Removed the unused import

#### 12. Frontend Proxy 204 Response Handling
- **Problem**: DELETE operations via frontend proxy failed with "Invalid response status code 204"
- **Fix**: Updated `app/api/[...path]/route.ts` to handle 204 responses specially (return null body)

#### 13. Node Position Auto-Save
- **Problem**: Node positions only saved when clicking "Save" button, causing positions to be lost on page reload
- **Fix**: Added `onNodeDragStop` handler to `app/projects/[id]/dag/page.tsx` that auto-saves position to backend when node drag ends

### Test Results - All Passing ✓
- Backend API: Projects, Actions, Edges, DAG endpoints all working
- Frontend: Home, Project, DAG pages all return 200
- API Proxy: GET, POST, DELETE all working via frontend proxy
- CORS: Correctly configured for `http://172.16.5.10:3000`
- DAG Operations:
  - ✓ Create Start/End nodes
  - ✓ Create edges between nodes
  - ✓ Delete edges
  - ✓ Delete nodes
  - ✓ Persistence across requests
  - ✓ Auto-save positions on drag (decimal precision preserved)

## Session 3 - 2026-01-01 (Agent Execution Pipeline)

### Architecture Changes

#### Directory Structure
```
data/
├── templates/                          # Action type templates
│   ├── build.md, unit-test.md, fixer.md, router.md, etc.
└── projects/{slug}/
    ├── .agentforge/                    # Project specs
    ├── actions/{action-id}/            # Per-action state
    │   └── completion_{timestamp}.md   # Saved completions
    └── services/{service-name}/        # Service workspaces
```

#### Execution Flow
1. Load template from `data/templates/{action.type}.md`
2. Inject as prompt to Claude CLI
3. Mount workspace (service or project dir)
4. Agent reads `/workspace/.agentforge/` for specs
5. Agent writes `/workspace/completion.md`
6. Backend copies to `actions/{id}/completion_{timestamp}.md`
7. Error context written to `.agentforge/error-context.json` for fixers

### Files Created
- `data/templates/*.md` - 10 template files (build, test types, fixer, router, etc.)
- `platform/backend/src/services/template-loader.ts` - Template loading service

### Files Modified
- `platform/backend/src/db/queries/actions.ts` - Create/delete action directories
- `platform/backend/src/utils/prompt-builder.ts` - Simplified to use template loader
- `platform/backend/src/services/agent-runner.ts` - Simplified mounts, write specs to .agentforge/
- `platform/backend/src/services/orchestrator.ts` - Copy completion, write error context
- `platform/frontend/app/projects/[id]/dag/page.tsx` - Removed Save button (auto-save now)

### Verified Working
- Action directory created on action creation
- Action directory deleted on action deletion
- Templates accessible from data/templates/
- Backend builds and runs without errors

## Docker Commands
```bash
# Rebuild everything
docker compose up -d --build

# Check logs
docker compose logs backend --tail 50
docker compose logs frontend --tail 50

# Restart specific service
docker compose restart backend
```

## Session 4 - 2026-01-01 (UI Features: Chat, Files, Editor)

### Features Added

#### 1. Action Chat in Specification Tab
- Per-action chat history stored in database
- New migration: `002_action_chats.ts`
- New queries: `db/queries/action-chats.ts`
- Chat persists across sessions (bound to action ID)
- Placeholder response (TODO: connect to Claude API)

#### 2. Action Files Browser in Specification Tab
- Browse files in `data/projects/{slug}/actions/{action-id}/`
- Create, view, and delete files
- New endpoints added to actions router

#### 3. Specification Tab Redesign
- Top: Monaco editor (resizable height)
- Bottom: Split view with FileBrowser (left) and Chat (right)
- Drag handle between editor and bottom section

#### 4. Code-Server Integration
- Backend Dockerfile: Install code-server + Claude Code extension
- docker-compose.yml: Expose ports 8900-8910
- New page: `/projects/[id]/editor`
- Start/stop code-server from UI
- Embedded iframe for full VS Code experience

### Files Created
- `backend/src/db/migrations/002_action_chats.ts`
- `backend/src/db/queries/action-chats.ts`
- `frontend/app/projects/[id]/editor/page.tsx`

### Files Modified
- `backend/src/db/connection.ts` - Added DbActionChat interface
- `backend/src/routes/actions.ts` - Added chat + file endpoints
- `backend/Dockerfile` - Install code-server + extension
- `docker-compose.yml` - Expose ports 8900-8910
- `frontend/lib/api.ts` - Added actionChatApi, actionFilesApi, types
- `frontend/components/dag/ActionPanel.tsx` - Redesigned Specification tab
- `frontend/app/projects/[id]/page.tsx` - Added Editor nav link

### New API Endpoints
```
GET  /api/projects/:pid/actions/:aid/chat       - List chat messages
POST /api/projects/:pid/actions/:aid/chat       - Create chat message
DELETE /api/projects/:pid/actions/:aid/chat     - Clear chat history
GET  /api/projects/:pid/actions/:aid/files      - List action files
GET  /api/projects/:pid/actions/:aid/files/:name - Get file content
POST /api/projects/:pid/actions/:aid/files      - Create/update file
DELETE /api/projects/:pid/actions/:aid/files/:name - Delete file
```

### To Test After Rebuild
```bash
# Rebuild
docker compose up -d --build backend frontend

# Test chat endpoints
curl -s "http://172.16.5.10:3001/api/projects/<project-id>/actions/<action-id>/chat"

# Test file endpoints
curl -s "http://172.16.5.10:3001/api/projects/<project-id>/actions/<action-id>/files"

# Open editor page
# Navigate to: http://172.16.5.10:3000/projects/<project-id>/editor
```
