import express from 'express';
import cors from 'cors';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connectDB } from './mongo';
import { config, promptPlaceholders, updatePromptPlaceholder } from './config';
import { wsClient } from './wsClient';
import {
  startWorkflow,
  getWorkflowStatus,
  listWorkflows,
  runStep,
  rerunFailedSessions,
  stopWorkflow,
  deleteWorkflow,
  workflowEvents,
} from './workflowEngine';
import { startWSServer } from './wsServer';

const app = express();

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════

function ensureOpenClawMemoryFiles(): void {
  try {
    const baseDir = path.join(os.homedir(), '.openclaw', 'workspace');
    const memoryDir = path.join(baseDir, 'memory');

    fs.mkdirSync(memoryDir, { recursive: true });

    const memoryIndex = path.join(baseDir, 'MEMORY.md');
    if (!fs.existsSync(memoryIndex)) {
      fs.writeFileSync(memoryIndex, '\n', 'utf8');
    }

    const now = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;

    const today = path.join(memoryDir, fmt(now));
    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterday = path.join(memoryDir, fmt(yesterdayDate));

    if (!fs.existsSync(today)) {
      fs.writeFileSync(today, '\n', 'utf8');
    }
    if (!fs.existsSync(yesterday)) {
      fs.writeFileSync(yesterday, '\n', 'utf8');
    }
  } catch (err) {
    console.warn('⚠️ Failed to initialize OpenClaw memory files:', err instanceof Error ? err.message : String(err));
  }
}

function parseWsTarget(wsUrl: string): { host: string; port: number } {
  const u = new URL(wsUrl);
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'wss:' ? 443 : 80);
  return { host: u.hostname, port };
}

async function checkTcp(host: string, port: number, timeoutMs = 800): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => onError(new Error('timeout')));
    socket.once('error', onError);
    socket.connect(port, host, () => {
      socket.end();
      resolve();
    });
  });
}

/**
 * GET /api/multibot/health
 * Returns whether the MultiBot endpoint is reachable.
 */
app.get('/api/multibot/health', async (_req, res) => {
  const { host, port } = parseWsTarget(config.wsUrl);
  try {
    await checkTcp(host, port, 800);
    if (wsClient.connected) {
      res.json({ ok: true, host, port, handshake: 'ok' });
      return;
    }

    const handshakeTimeoutMs = 1500;
    await Promise.race([
      wsClient.connect(),
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('handshake timeout')), handshakeTimeoutMs)
      ),
    ]);

    res.json({ ok: wsClient.connected, host, port, handshake: wsClient.connected ? 'ok' : 'failed' });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(503).json({ ok: false, host, port, handshake: 'failed', error: errMsg });
  }
});

/**
 * POST /api/workflow/start
 * Start a new workflow with the given context block.
 */
app.post('/api/workflow/start', async (req, res) => {
  try {
    const { contextBlock } = req.body;

    if (!contextBlock || typeof contextBlock !== 'string') {
      res.status(400).json({ error: 'contextBlock is required and must be a string' });
      return;
    }

    const workflow = await startWorkflow(contextBlock);

    res.status(201).json({
      success: true,
      gapId: workflow.gapId,
      message: 'Workflow started',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ POST /api/workflow/start error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/workflow/:gapId/status
 * Poll the current status of a workflow.
 */
app.get('/api/workflow/:gapId/status', async (req, res) => {
  try {
    const { gapId } = req.params;
    const status = await getWorkflowStatus(gapId);

    if (!status) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json(status);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ GET /api/workflow/:gapId/status error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/workflows
 * List all workflows (for history panel).
 */
app.get('/api/workflows', async (_req, res) => {
  try {
    const workflows = await listWorkflows();
    res.json(workflows);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ GET /api/workflows error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/workflow/:gapId/step/:step/run
 * Run a specific step for a workflow.
 */
app.post('/api/workflow/:gapId/step/:step/run', async (req, res) => {
  try {
    const { gapId, step } = req.params;

    // Run step in background, respond immediately
    res.json({ success: true, message: `Step ${step} started for ${gapId}` });

    setImmediate(() => {
      runStep(gapId, step).catch((err) => {
        console.error(`❌ Step ${step} error for ${gapId}:`, err.message);
      });
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ POST step/run error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/workflow/:gapId/step/:step/rerun-failed
 * Re-run only failed sessions for a step.
 */
app.post('/api/workflow/:gapId/step/:step/rerun-failed', async (req, res) => {
  try {
    const { gapId, step } = req.params;

    res.json({ success: true, message: `Re-running failed sessions for ${step} in ${gapId}` });

    setImmediate(() => {
      rerunFailedSessions(gapId, step).catch((err) => {
        console.error(`❌ Rerun ${step} error for ${gapId}:`, err.message);
      });
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ POST rerun-failed error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/workflow/:gapId/stop
 * Stop a currently running workflow.
 */
app.post('/api/workflow/:gapId/stop', async (req, res) => {
  try {
    const { gapId } = req.params;
    await stopWorkflow(gapId);
    res.json({ success: true, message: `Workflow ${gapId} stopped` });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ POST workflow/stop error:', errMsg);
    res.status(400).json({ error: errMsg });
  }
});

/**
 * DELETE /api/workflow/:gapId
 * Delete a workflow and all its step outputs.
 */
app.delete('/api/workflow/:gapId', async (req, res) => {
  try {
    const { gapId } = req.params;
    await deleteWorkflow(gapId);
    res.json({ success: true, message: `Workflow ${gapId} deleted` });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ DELETE workflow error:', errMsg);
    res.status(400).json({ error: errMsg });
  }
});

/**
 * GET /api/prompts
 * Get all prompt placeholders.
 */
app.get('/api/prompts', (_req, res) => {
  res.json(promptPlaceholders);
});

/**
 * PUT /api/prompts
 * Update prompt placeholders from the frontend editor.
 */
app.put('/api/prompts', (req, res) => {
  const updates: Record<string, string> = req.body;

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'string') {
      updatePromptPlaceholder(key, value);
    }
  }

  res.json({ success: true, prompts: promptPlaceholders });
});

// ═══════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════

async function main(): Promise<void> {
  // Best-effort: create missing OpenClaw memory files to avoid ENOENT in gateway tools.
  ensureOpenClawMemoryFiles();

  await connectDB();

  // Start frontend WebSocket server
  startWSServer();

  app.listen(config.port, () => {
    console.log(`🚀 Server listening on port ${config.port}`);
    console.log(`   GET  /api/multibot/health`);
    console.log(`   POST /api/workflow/start`);
    console.log(`   GET  /api/workflow/:gapId/status`);
    console.log(`   GET  /api/workflows`);
    console.log(`   POST /api/workflow/:gapId/step/:step/run`);
    console.log(`   POST /api/workflow/:gapId/step/:step/rerun-failed`);
    console.log(`   GET  /api/prompts`);
    console.log(`   PUT  /api/prompts`);
  });

  workflowEvents.on('workflow_event', (event) => {
    console.log(`📡 Event [${event.type}]:`, JSON.stringify(event.data).substring(0, 200));
  });
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
