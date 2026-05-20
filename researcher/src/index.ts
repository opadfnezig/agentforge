import WebSocket from 'ws';
import { spawn, ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import * as readline from 'readline';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  coordinatorUrl: string;
  researcherId: string;
  researcherSecret: string;
  workspacePath: string;
  resultsDir: string;
  maxTurns: number;
  model: string | undefined;
}

function loadConfig(): Config {
  const coordinatorUrl = process.env.COORDINATOR_URL;
  const researcherId = process.env.RESEARCHER_ID;
  const researcherSecret = process.env.RESEARCHER_SECRET;
  const workspacePath = process.env.WORKSPACE_PATH || '/workspace';
  const resultsDir = process.env.RESULTS_DIR || `${workspacePath}/results`;
  const maxTurns = parseInt(process.env.MAX_TURNS || '1000', 10);
  const model = process.env.RESEARCHER_MODEL || undefined;

  if (!coordinatorUrl) throw new Error('COORDINATOR_URL is required');
  if (!researcherId) throw new Error('RESEARCHER_ID is required');
  if (!researcherSecret) throw new Error('RESEARCHER_SECRET is required');

  return { coordinatorUrl, researcherId, researcherSecret, workspacePath, resultsDir, maxTurns, model };
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
// Prompt templates
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an AgentForge researcher. The user dispatches you with research questions. You investigate, verify, and report what you actually found.

## How to work

**State intent before each tool call.** Before you read a file, run a search, or fetch a URL, write one sentence: what you're checking and why. Before, not after. Post-hoc narration ("I read X to find Y") is a tell that you skipped the thinking step. Intent first, then tool call.

**Doubt everything — including the user's own docs.** Oracle memory, prior reports, the framing inside your dispatch — all of it can be wrong, stale, or the same lazy retrieval you're being asked to replace. When a claim is load-bearing, verify it against raw data: the actual chat dump, the actual database row, the actual file content. The user built their oracle docs themselves and knows what's in their filesystem; summarizing those back is not research.

**Find signal, don't restate it.** Use grep, sqlite, n-gram counts, control cases, direct measurement of raw artifacts. If your answer could have been produced by listing file paths the user already knows about, you haven't done the work. The job is to surface what they couldn't get by re-reading their own notes.

**Calibrate confidence to evidence.** If n=1, say n=1. If you couldn't verify something, say so. Walk back hypotheses mid-investigation when data refutes them — don't carry dead claims into the writeup. A withdrawn claim from a control case beats a confident claim from a template.

## Output

Write findings to results/<timestamp>-<slug>.md (timestamp: YYYYMMDD-HHmmss UTC; slug: 2-4 word kebab-case).

No fixed section template. No mandatory Summary / Findings / Sources scaffold — formal structure tries to do the work that content should do, and it's the giveaway that a report was performed instead of written. Match length to signal: short when the answer is short; longer only when raw evidence demands it. Cite inline with the specific file path + line, query, count, or quote. When you reference oracle or memory docs, treat them as claims to verify, not as authority.

End with a 2-3 sentence summary and the file path in your final message.`;

function buildResearchPrompt(instructions: string, resumeContext: string | null | undefined): string {
  let prompt = '';
  if (resumeContext && resumeContext.length > 0) {
    prompt += `## Previous attempt context\n${resumeContext}\n\n`;
  }
  prompt += `## Research task\n${instructions}\n\nWrite your findings to a markdown file in the results/ directory, then summarize.`;
  return prompt;
}

// ---------------------------------------------------------------------------
// WebSocket client with reconnect
// ---------------------------------------------------------------------------

type DispatchMessage = {
  type: 'dispatch';
  runId: string;
  instructions: string;
  resumeContext?: string | null;
};

type IncomingMessage = DispatchMessage | { type: string; [k: string]: unknown };

class ResearcherClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;
  private currentRun: { runId: string; child: ChildProcess | null } | null = null;

  constructor(private config: Config) {}

  start(): void {
    // Ensure results directory exists
    mkdirSync(this.config.resultsDir, { recursive: true });

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
    const { coordinatorUrl, researcherId, researcherSecret } = this.config;
    const url = `${coordinatorUrl}/api/researchers/connect/${encodeURIComponent(researcherId)}?secret=${encodeURIComponent(researcherSecret)}`;
    log(`Connecting to ${url.replace(researcherSecret, '***')}`);

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
    const { runId, instructions, resumeContext } = msg;
    log(`Dispatch runId=${runId}${resumeContext ? ' (with resume_context)' : ''}`);

    if (this.currentRun) {
      logErr(`Rejecting dispatch; run ${this.currentRun.runId} already in progress`);
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error_message: 'Researcher is busy with another run',
      });
      return;
    }

    this.currentRun = { runId, child: null };
    this.send({ type: 'run_update', runId, status: 'running' });

    const prompt = buildResearchPrompt(instructions, resumeContext);
    const { exitCode, finalAssistantText, errorText } = await this.runClaude(runId, prompt);

    if (exitCode !== 0) {
      this.send({
        type: 'run_update',
        runId,
        status: 'failure',
        error_message: errorText || `claude exited with code ${exitCode}`,
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

      // Pipe prompt via stdin to bypass ARG_MAX.
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
  log(`Starting AgentForge researcher id=${config.researcherId} workspace=${config.workspacePath}`);
  const client = new ResearcherClient(config);
  client.start();
}

main();
