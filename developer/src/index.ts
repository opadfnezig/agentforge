import WebSocket from 'ws';
import { spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import * as readline from 'readline';
import 'dotenv/config';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  coordinatorUrl: string;
  developerId: string;
  developerSecret: string;
  workspacePath: string;
  gitBranch: string;
  maxTurns: number;
}

function loadConfig(): Config {
  const coordinatorUrl = process.env.COORDINATOR_URL;
  const developerId = process.env.DEVELOPER_ID;
  const developerSecret = process.env.DEVELOPER_SECRET;
  const workspacePath = process.env.WORKSPACE_PATH;
  const gitBranch = process.env.GIT_BRANCH || 'main';
  const maxTurns = parseInt(process.env.MAX_TURNS || '300', 10);

  if (!coordinatorUrl) throw new Error('COORDINATOR_URL is required');
  if (!developerId) throw new Error('DEVELOPER_ID is required');
  if (!developerSecret) throw new Error('DEVELOPER_SECRET is required');
  if (!workspacePath) throw new Error('WORKSPACE_PATH is required');

  return { coordinatorUrl, developerId, developerSecret, workspacePath, gitBranch, maxTurns };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  if (extra !== undefined) {
    console.log(`[${ts}] ${msg}`, extra);
  } else {
    console.log(`[${ts}] ${msg}`);
  }
}

function logErr(msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  if (extra !== undefined) {
    console.error(`[${ts}] ${msg}`, extra);
  } else {
    console.error(`[${ts}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 32 });
  return { stdout, stderr };
}

async function gitHeadSha(cwd: string): Promise<string> {
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd);
  return stdout.trim();
}

async function gitPullRebase(cwd: string, branch: string): Promise<void> {
  await git(['pull', '--rebase', 'origin', branch], cwd);
}

async function gitHasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await git(['status', '--porcelain'], cwd);
  return stdout.trim().length > 0;
}

async function gitCommitAndPush(cwd: string, message: string, branch: string): Promise<void> {
  await git(['add', '-A'], cwd);
  await git(['commit', '-m', message], cwd);
  await git(['push', 'origin', branch], cwd);
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

function buildTaskSection(instructions: string, resumeContext: string | null | undefined, taskHeader: string): string {
  if (resumeContext && resumeContext.length > 0) {
    return `## Previous attempt context
${resumeContext}
## Current task
${instructions}`;
  }
  return `${taskHeader}
${instructions}`;
}

function buildImplementPrompt(instructions: string, resumeContext?: string | null): string {
  return `You are an AgentForge developer working on the project at /workspace.

## Critical guidance
- USE BULK READS. It is always better to read extra files in parallel than to waste a turn reading something you obviously had to anyway. When you need to understand a module, read the main file AND the related files AND the tests in one tool call, not sequentially.
- Never assume. If instructions are ambiguous, finish the current task and leave a note. If instructions are fundamentally unclear, stop and explain what's missing — the user will re-dispatch in 'clarify' mode.
- Match existing code style. Read similar files before writing new ones.
- Don't add features beyond what's asked. Don't write tests unless asked. Don't refactor surrounding code unless asked.

## Required dispatch structure
A well-formed dispatch from the coordinator MUST contain these four labeled sections:

1. **STOP criteria** — when to halt and report instead of guessing.
2. **Out of scope** — what NOT to touch.
3. **Commit/report contract** — expected commit messages, push-or-not, final-report contents.
4. **Read-before-write requirements** — files/components/schemas to bulk-read before any write.

Before doing anything else, scan the Task below for these four sections. If any are missing, contradictory, or obviously wrong for the task:
- Do NOT proceed with implementation.
- Do a minimal read of the code to confirm the ambiguity is real (not just unfamiliar naming).
- Finish by reporting: "MISSING/AMBIGUOUS DISPATCH SECTIONS" plus a bulleted list of what's missing and the specific questions you need answered. The coordinator will re-dispatch in clarify mode.

If all four sections are present and coherent, proceed. Respect the STOP criteria mid-run — if you hit one during execution, halt and report rather than guessing.

${buildTaskSection(instructions, resumeContext, '## Task')}

Complete the task. You don't need to commit — the coordinator handles that after you finish.
`;
}

function buildClarifyPrompt(instructions: string, resumeContext?: string | null): string {
  return `You are an AgentForge developer in CLARIFY mode. You will NOT make changes. Your job is to:
1. Read the relevant files to understand the current state
2. Identify ambiguities in the instructions
3. Return specific questions that need answers before implementation can proceed

USE BULK READS — read multiple related files in parallel. Understand the code before asking.

## Required dispatch structure
A well-formed dispatch should contain four labeled sections: STOP criteria, Out of scope, Commit/report contract, Read-before-write requirements. In clarify mode, if any of these are missing, flag that explicitly in your questions — the coordinator needs to add them before you can implement.

${buildTaskSection(instructions, resumeContext, '## Task (do not implement, only clarify)')}

Return ONLY the clarifying questions. Be specific. Reference file paths and line numbers. If there are no ambiguities, say so and list your planned approach for confirmation.
`;
}

// ---------------------------------------------------------------------------
// WebSocket client with reconnect
// ---------------------------------------------------------------------------

type DispatchMessage = {
  type: 'dispatch';
  runId: string;
  instructions: string;
  mode: 'implement' | 'clarify';
  resumeContext?: string | null;
};

type IncomingMessage = DispatchMessage | { type: string; [k: string]: unknown };

class DeveloperClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;
  private currentRun: { runId: string; child: ChildProcess | null } | null = null;

  constructor(private config: Config) {}

  start(): void {
    this.connect();

    const shutdown = () => {
      this.shuttingDown = true;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.ws) {
        try { this.ws.close(); } catch { /* noop */ }
      }
      if (this.currentRun?.child && !this.currentRun.child.killed) {
        try { this.currentRun.child.kill('SIGTERM'); } catch { /* noop */ }
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private connect(): void {
    const { coordinatorUrl, developerId, developerSecret } = this.config;
    const url = `${coordinatorUrl}/api/developers/connect/${encodeURIComponent(developerId)}?secret=${encodeURIComponent(developerSecret)}`;
    log(`Connecting to ${url.replace(developerSecret, '***')}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      log('WebSocket connected');
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let parsed: IncomingMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        logErr('Failed to parse incoming message', err);
        return;
      }
      this.handleMessage(parsed).catch((err) => {
        logErr('handleMessage error', err);
      });
    });

    ws.on('close', (code, reason) => {
      log(`WebSocket closed code=${code} reason=${reason?.toString()}`);
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.shuttingDown) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logErr('WebSocket error', err);
    });
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempt++;
    const base = Math.min(1000 * Math.pow(2, attempt), 60_000);
    const jitter = Math.floor(Math.random() * 1000);
    const delay = base + jitter;
    log(`Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, 30_000);
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logErr('Cannot send, socket not open', obj);
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      logErr('send error', err);
    }
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type === 'dispatch') {
      const d = msg as DispatchMessage;
      await this.handleDispatch(d);
      return;
    }
    log(`Unhandled message type=${msg.type}`);
  }

  private async handleDispatch(msg: DispatchMessage): Promise<void> {
    const { runId, instructions, mode, resumeContext } = msg;
    log(`Dispatch runId=${runId} mode=${mode}${resumeContext ? ' (with resume_context)' : ''}`);

    if (this.currentRun) {
      logErr(`Rejecting dispatch; run ${this.currentRun.runId} already in progress`);
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error_message: 'Developer is busy with another run',
      });
      return;
    }

    this.currentRun = { runId, child: null };

    // Check if workspace is a git repo. If not, skip all git operations.
    let isGitRepo = false;
    try {
      await gitHeadSha(this.config.workspacePath);
      isGitRepo = true;
    } catch {
      logErr('Workspace is not a git repo — git operations will be skipped', null);
    }

    let gitShaStart: string | null = null;
    if (isGitRepo) {
      try {
        gitShaStart = await gitHeadSha(this.config.workspacePath);
      } catch (err) {
        logErr('Failed to read starting SHA', err);
      }
    }

    this.send({
      type: 'run_update',
      runId,
      status: 'running',
      git_sha_start: gitShaStart,
    });

    // git pull --rebase before starting (only if git repo)
    if (isGitRepo) {
      try {
        await gitPullRebase(this.config.workspacePath, this.config.gitBranch);
      } catch (err) {
        logErr('git pull --rebase failed (non-fatal, continuing)', err);
      }
    }

    const prompt = mode === 'clarify'
      ? buildClarifyPrompt(instructions, resumeContext)
      : buildImplementPrompt(instructions, resumeContext);

    const { exitCode, finalAssistantText } = await this.runClaude(runId, prompt);

    if (exitCode !== 0) {
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error_message: `claude exited with code ${exitCode}`,
      });
      this.currentRun = null;
      return;
    }

    if (mode === 'clarify') {
      this.send({
        type: 'run_update',
        runId,
        status: 'success',
        response: finalAssistantText,
        push_status: 'not_attempted',
      });
      this.currentRun = null;
      return;
    }

    // implement mode — commit if changes (and if git repo).
    // Work success is independent of push success: a failed push must not
    // flip a completed run to 'failure'. push_status carries the push outcome.
    if (!isGitRepo) {
      this.send({
        type: 'run_update',
        runId,
        status: 'success',
        response: finalAssistantText,
        push_status: 'not_attempted',
      });
      this.currentRun = null;
      return;
    }

    let hasChanges = false;
    try {
      hasChanges = await gitHasChanges(this.config.workspacePath);
    } catch (err) {
      logErr('git status failed', err);
      this.send({
        type: 'run_update',
        runId,
        status: 'success',
        response: finalAssistantText,
        push_status: 'failed',
        push_error: `git status failed: ${(err as Error).message}`,
      });
      this.currentRun = null;
      return;
    }

    if (!hasChanges) {
      const sha = await gitHeadSha(this.config.workspacePath).catch(() => gitShaStart);
      this.send({
        type: 'run_update',
        runId,
        status: 'no_changes',
        git_sha_end: sha,
        response: finalAssistantText,
        push_status: 'not_attempted',
      });
      this.currentRun = null;
      return;
    }

    const firstLine = (instructions.split('\n')[0] || 'update').trim().slice(0, 200);
    const commitMessage = `agentforge: ${firstLine}`;

    try {
      await gitCommitAndPush(this.config.workspacePath, commitMessage, this.config.gitBranch);
    } catch (err) {
      logErr('git commit/push failed', err);
      // Work succeeded; push didn't. Record overall run as success, and
      // surface the push problem via push_status/push_error so the UI can
      // badge it separately.
      const sha = await gitHeadSha(this.config.workspacePath).catch(() => '');
      this.send({
        type: 'run_update',
        runId,
        status: 'success',
        git_sha_end: sha,
        response: finalAssistantText,
        push_status: 'failed',
        push_error: `git commit/push failed: ${(err as Error).message}`,
      });
      this.currentRun = null;
      return;
    }

    const gitShaEnd = await gitHeadSha(this.config.workspacePath).catch(() => '');
    this.send({
      type: 'run_update',
      runId,
      status: 'success',
      git_sha_end: gitShaEnd,
      response: finalAssistantText,
      push_status: 'pushed',
    });
    this.currentRun = null;
  }

  private runClaude(runId: string, prompt: string): Promise<{ exitCode: number; finalAssistantText: string }> {
    return new Promise((resolve) => {
      const args = [
        '--dangerously-skip-permissions',
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--max-turns', String(this.config.maxTurns),
        prompt,
      ];

      log(`Spawning claude for runId=${runId}`);
      const child = spawn('claude', args, {
        cwd: this.config.workspacePath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (this.currentRun && this.currentRun.runId === runId) {
        this.currentRun.child = child;
      }

      let finalAssistantText = '';

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: { type?: string; [k: string]: unknown };
        try {
          evt = JSON.parse(trimmed);
        } catch {
          // Not JSON — forward as raw text event
          this.send({
            type: 'event',
            runId,
            event_type: 'raw',
            data: { text: trimmed },
          });
          return;
        }

        const eventType = typeof evt.type === 'string' ? evt.type : 'unknown';

        // Track assistant text messages so we can report the final one
        if (eventType === 'assistant') {
          const msgField = (evt as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
          if (msgField?.content && Array.isArray(msgField.content)) {
            const textParts = msgField.content
              .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string);
            if (textParts.length > 0) {
              finalAssistantText = textParts.join('\n');
            }
          }
        }

        this.send({
          type: 'event',
          runId,
          event_type: eventType,
          data: evt,
        });
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        logErr(`[claude stderr] ${text}`);
        this.send({
          type: 'event',
          runId,
          event_type: 'stderr',
          data: { text },
        });
      });

      child.on('error', (err) => {
        logErr('claude spawn error', err);
      });

      child.on('close', (code) => {
        log(`claude exited code=${code} runId=${runId}`);
        resolve({ exitCode: code ?? 1, finalAssistantText });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(): void {
  const config = loadConfig();
  log(`Starting AgentForge developer id=${config.developerId} workspace=${config.workspacePath} branch=${config.gitBranch}`);
  const client = new DeveloperClient(config);
  client.start();
}

main();

