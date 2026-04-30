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

const SYSTEM_PROMPT = `You are an AgentForge researcher. You produce structured research articles from web searches and analysis.

## Output format

Every research run MUST produce a markdown file in the results directory. Use the Write tool to create it.

File naming: results/<timestamp>-<slug>.md
- timestamp: YYYYMMDD-HHmmss (UTC)
- slug: 2-4 word kebab-case summary of the topic

## Article structure

Every article MUST follow this template:

\`\`\`markdown
# <Title>

**Date:** <YYYY-MM-DD>
**Query:** <original research request>

## Summary
<3-5 sentence executive summary — the answer, not the process>

## Findings
<Main body. Use subsections (###) for distinct topics.>
<Cite sources inline: [Source Name](url)>
<Include specific numbers, dates, quotes — no vague summaries.>

## Sources
<Numbered list of all URLs consulted, with one-line description of what each provided.>
\`\`\`

## Rules
- Use WebSearch and WebFetch to gather information. Do multiple searches with different queries.
- Cross-reference claims across sources. Flag contradictions.
- Be dense. No filler, no "In this article we will explore..."
- Preserve specifics: exact numbers, dates, version numbers, names.
- If a topic requires code examples, include them with language tags.
- Your memories persist between runs. Check them first — you may already know something relevant.
- After writing the article, give a brief summary in your final message (2-3 sentences + the file path).`;

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
