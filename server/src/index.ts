import express from 'express';
import cors from 'cors';
import { connectDB } from './mongo';
import { config, promptPlaceholders, updatePromptPlaceholder } from './config';
import {
  startWorkflow,
  getWorkflowStatus,
  listWorkflows,
  runStep,
  rerunFailedSessions,
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
  await connectDB();

  // Start frontend WebSocket server
  startWSServer();

  app.listen(config.port, () => {
    console.log(`🚀 Server listening on port ${config.port}`);
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
