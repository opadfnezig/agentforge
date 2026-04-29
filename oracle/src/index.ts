import WebSocket from 'ws';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  coordinatorUrl: string;
  oracleId: string;
  oracleSecret: string;
  workspacePath: string;
  maxTurns: number;
  model: string | undefined;
}

function loadConfig(): Config {
  const coordinatorUrl = process.env.COORDINATOR_URL;
  const oracleId = process.env.ORACLE_ID;
  const oracleSecret = process.env.ORACLE_SECRET;
  // Pinned to /workspace so the claude CLI's memory dir resolves to a
  // stable path (~/.claude/projects/-workspace/memory) the host can mount.
  const workspacePath = process.env.WORKSPACE_PATH || '/workspace';
  const maxTurns = parseInt(process.env.MAX_TURNS || '30', 10);
  const model = process.env.ORACLE_MODEL || undefined;

  if (!coordinatorUrl) throw new Error('COORDINATOR_URL is required');
  if (!oracleId) throw new Error('ORACLE_ID is required');
  if (!oracleSecret) throw new Error('ORACLE_SECRET is required');

  return { coordinatorUrl, oracleId, oracleSecret, workspacePath, maxTurns, model };
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
// Prompt templates per mode
// ---------------------------------------------------------------------------

type Mode = 'read' | 'write' | 'migrate';

const SYSTEM_PROMPT =
  'You are a knowledge oracle backed by Claude memory. Your memories live under your resolved memory directory. Read them with the Read tool. Do not write to /data except to delete files during migrate mode. Follow the user instructions exactly.';

function buildReadPrompt(message: string): string {
  return `You are a knowledge oracle. Answer ONLY from your memories.

Rules:
- Read your memory files first.
- Cite the relevant section/heading when possible.
- If your memories do not contain the answer, say "Not in my memories."
- Do not speculate or use general knowledge.
- Be dense. No filler.

Question: ${message}`;
}

function buildWritePrompt(newData: string): string {
  return `You are a knowledge oracle maintaining your memory files. Read your current memories first, then merge the new information in.

Rules:
- Read your current memory files first.
- Merge the new information into the appropriate place — DO NOT just append.
- Update existing sections if the new info refines/contradicts them.
- Add new sections (or new memory files) if the info covers a new topic.
- Maintain existing structure and style.
- Do NOT remove existing information unless the new info explicitly supersedes it.
- Write the updated memory back using Edit or Write tools.

New information to integrate:
${newData}`;
}

function buildMigratePrompt(): string {
  return `You are a knowledge oracle migrating staged data into your memories.

Procedure:
1. List files under /data.
2. For each file, read it and merge its content into the appropriate memory file (creating new memory files where needed). Maintain existing structure and style; do not just append.
3. After a file's content is fully integrated into your memories, delete the source file from /data.
4. When /data is empty (or only contains files you cannot integrate), report what was migrated and what (if anything) was skipped and why.

Do not write new files into /data. Only read and delete from /data.`;
}

function buildPrompt(mode: Mode, payload: string): string {
  if (mode === 'read') return buildReadPrompt(payload);
  if (mode === 'write') return buildWritePrompt(payload);
  return buildMigratePrompt();
}

// ---------------------------------------------------------------------------
// WebSocket client with reconnect
// ---------------------------------------------------------------------------

interface DispatchMessage {
  type: 'dispatch';
  runId: string;
  mode: Mode;
  payload: string;
}

type IncomingMessage = DispatchMessage | { type: string; [k: string]: unknown };

class OracleClient {
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
    const { coordinatorUrl, oracleId, oracleSecret } = this.config;
    const url = `${coordinatorUrl}/api/oracles/connect/${encodeURIComponent(oracleId)}?secret=${encodeURIComponent(oracleSecret)}`;
    log(`Connecting to ${url.replace(oracleSecret, '***')}`);

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
      await this.handleDispatch(msg as DispatchMessage);
      return;
    }
    log(`Unhandled message type=${msg.type}`);
  }

  private async handleDispatch(msg: DispatchMessage): Promise<void> {
    const { runId, mode, payload } = msg;
    log(`Dispatch runId=${runId} mode=${mode}`);

    if (this.currentRun) {
      logErr(`Rejecting dispatch; run ${this.currentRun.runId} already in progress`);
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error: 'Oracle is busy with another run',
      });
      return;
    }

    if (mode !== 'read' && mode !== 'write' && mode !== 'migrate') {
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error: `Unknown mode: ${mode}`,
      });
      return;
    }

    this.currentRun = { runId, child: null };
    this.send({ type: 'run_update', runId, status: 'running' });

    const prompt = buildPrompt(mode, payload);
    const { exitCode, finalAssistantText, errorText } = await this.runClaude(runId, prompt);

    if (exitCode !== 0) {
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error: errorText || `claude exited with code ${exitCode}`,
      });
      this.currentRun = null;
      return;
    }

    this.send({
      type: 'run_update',
      runId,
      status: 'success',
      response: finalAssistantText,
    });
    this.currentRun = null;
  }

  private runClaude(
    runId: string,
    prompt: string,
  ): Promise<{ exitCode: number; finalAssistantText: string; errorText: string }> {
    return new Promise((resolve) => {
      const args = [
        '--dangerously-skip-permissions',
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--max-turns', String(this.config.maxTurns),
        '--system-prompt', SYSTEM_PROMPT,
        ...(this.config.model ? ['--model', this.config.model] : []),
      ];

      log(`Spawning claude for runId=${runId} (prompt via stdin, ${prompt.length} chars)`);
      const child = spawn('claude', args, {
        cwd: this.config.workspacePath,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (this.currentRun && this.currentRun.runId === runId) {
        this.currentRun.child = child;
      }

      // Pipe the prompt in via stdin to bypass ARG_MAX.
      child.stdin!.write(prompt);
      child.stdin!.end();

      let finalAssistantText = '';
      let rawStdout = '';
      let stderr = '';

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        rawStdout += line + '\n';
        let evt: { type?: string; [k: string]: unknown };
        try {
          evt = JSON.parse(trimmed);
        } catch {
          this.send({
            type: 'event',
            runId,
            event_type: 'raw',
            data: { text: trimmed },
          });
          return;
        }

        const eventType = typeof evt.type === 'string' ? evt.type : 'unknown';

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
        } else if (eventType === 'result') {
          const result = (evt as { result?: string }).result;
          if (!finalAssistantText && typeof result === 'string') {
            finalAssistantText = result;
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
        stderr += text;
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
        // Surface non-JSON stdout lines as fallback error context (matches
        // oracle-engine's prior pattern: e.g. "Error: Reached max turns").
        let errorText = stderr.trim();
        if (!errorText) {
          const errLines = rawStdout.split('\n').filter((l) => {
            if (!l.trim()) return false;
            try { JSON.parse(l); return false; } catch { return true; }
          });
          errorText = errLines.join(' ').slice(0, 500);
        }
        resolve({ exitCode: code ?? 1, finalAssistantText: finalAssistantText.trim(), errorText });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(): void {
  const config = loadConfig();
  log(`Starting AgentForge oracle id=${config.oracleId} workspace=${config.workspacePath}`);
  const client = new OracleClient(config);
  client.start();
}

main();
