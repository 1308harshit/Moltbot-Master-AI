import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Workflow, IWorkflow, STEP_PREREQUISITES, IStepStatus } from './models/Workflow';
import { StepOutput } from './models/StepOutput';
import { wsClient } from './wsClient';
import { pushToCoda } from './coda';
import { config, promptPlaceholders } from './config';

// Event emitter for real-time frontend notifications
export const workflowEvents = new EventEmitter();

export interface WorkflowEvent {
  type: 'status_change' | 'step_status_change' | 'panel_complete' | 'step_complete' | 'workflow_failed' | 'workflow_completed';
  gapId: string;
  data: Record<string, unknown>;
}

function emit(event: WorkflowEvent): void {
  workflowEvents.emit('workflow_event', event);
}

/**
 * Build the full prompt for a step by injecting the placeholder + context block.
 */
function buildPrompt(placeholderKey: string, contextBlock: string, snapshot?: Record<string, string>): string {
  const source = snapshot || promptPlaceholders;
  const template = source[placeholderKey] || `{${placeholderKey}}`;
  return `${template}\n\n${contextBlock}`;
}

/**
 * Validate that the response contains the expected end-of-step marker.
 */
function validateMarker(output: string, step: string): boolean {
  const markers: Record<string, string> = {
    step1: '=== END OF STEP 1 ===',
    step2a: '=== END OF STEP 2A ===',
    step2b: '=== END OF STEP 2B ===',
    step2c: '=== END OF STEP 2C ===',
    step3: '=== END OF STEP 3 ===',
  };
  const marker = markers[step] || `=== END OF ${step.toUpperCase()} ===`;
  return output.includes(marker);
}

/**
 * Check if a step's prerequisites are all completed.
 */
export function canRunStep(workflow: IWorkflow, step: string): { allowed: boolean; reason?: string } {
  const prereqs = STEP_PREREQUISITES[step] || [];
  for (const prereq of prereqs) {
    const stepStatuses = workflow.stepStatuses as unknown as Record<string, IStepStatus>;
    const prereqStatus = stepStatuses?.[prereq];
    if (!prereqStatus || prereqStatus.status !== 'completed') {
      return { allowed: false, reason: `Prerequisite "${prereq}" is not completed (current: ${prereqStatus?.status || 'unknown'})` };
    }
  }
  return { allowed: true };
}

/**
 * Get the prompt key for a step.
 */
function getPromptKey(step: string): string {
  const map: Record<string, string> = {
    step1: 'default_prompt_step1',
    step2a: 'default_prompt_step2a',
    step2b: 'default_prompt_step2b',
    step2c: 'default_prompt_step2c',
    step3: 'default_prompt_step3',
  };
  return map[step] || `default_prompt_${step}`;
}

/**
 * Execute a single panel session.
 */
async function executePanel(
  gapId: string,
  step: string,
  session: number,
  panelId: number,
  prompt: string
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    console.log(`🔄 [${gapId}] ${step} — session ${session}, panel ${panelId}: sending...`);

    const output = await wsClient.sendToPanel(panelId, prompt);
    const passed = validateMarker(output, step);

    // Store in MongoDB
    await StepOutput.create({
      gapId, step, session, panel: panelId,
      output, validationPassed: passed, storedInCoda: false,
    });

    emit({
      type: 'panel_complete',
      gapId,
      data: { step, session, panelId, passed },
    });

    if (!passed) {
      return {
        success: false, output,
        error: `Validation failed: marker not found in session ${session}`,
      };
    }

    // Push to Coda
    const codaOk = await pushToCoda({
      gapId, step, session,
      outputSummary: output.substring(0, 500),
      status: 'passed',
      timestamp: new Date().toISOString(),
    });

    if (codaOk) {
      await StepOutput.updateOne(
        { gapId, step, session, panel: panelId },
        { storedInCoda: true }
      );
    }

    return { success: true, output };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    await StepOutput.create({
      gapId, step, session, panel: panelId,
      output: `ERROR: ${errMsg}`, validationPassed: false, storedInCoda: false,
    });

    emit({
      type: 'panel_complete',
      gapId,
      data: { step, session, panelId, passed: false, error: errMsg },
    });

    return { success: false, output: '', error: errMsg };
  }
}

/**
 * Update a step's status in the Workflow document.
 */
async function updateStepStatus(
  gapId: string,
  step: string,
  update: Partial<IStepStatus>
): Promise<void> {
  const setFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    setFields[`stepStatuses.${step}.${key}`] = value;
  }
  await Workflow.updateOne({ gapId }, { $set: setFields });

  emit({
    type: 'step_status_change',
    gapId,
    data: { step, ...update },
  });
}

/**
 * Run a specific step for a workflow.
 */
export async function runStep(gapId: string, step: string): Promise<void> {
  const workflow = await Workflow.findOne({ gapId });
  if (!workflow) throw new Error(`Workflow ${gapId} not found`);

  // Enforce step locking
  const check = canRunStep(workflow, step);
  if (!check.allowed) {
    throw new Error(check.reason!);
  }

  // Get session count for this step
  const stepStatuses = workflow.stepStatuses as unknown as Record<string, IStepStatus>;
  const stepInfo = stepStatuses?.[step];
  const totalSessions = stepInfo?.totalSessions || config.panelCount;

  // Mark step running
  await Workflow.updateOne({ gapId }, {
    currentStep: step,
    status: 'running',
  });
  await updateStepStatus(gapId, step, {
    status: 'running',
    completedSessions: 0,
    failedSessions: [],
  });

  emit({
    type: 'status_change',
    gapId,
    data: { status: 'running', currentStep: step },
  });

  try {
    await wsClient.connect();

    const promptKey = getPromptKey(step);
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | undefined;
    const prompt = buildPrompt(promptKey, workflow.contextBlock, snapshot);

    // Launch sessions in parallel
    const results = await Promise.all(
      Array.from({ length: totalSessions }, (_, i) => i + 1).map(
        (sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt)
      )
    );

    // Tally results
    let completedCount = 0;
    const failedIds: number[] = [];

    results.forEach((r, idx) => {
      if (r.success) {
        completedCount++;
      } else {
        failedIds.push(idx + 1);
      }
    });

    // Update step status atomically
    await updateStepStatus(gapId, step, {
      completedSessions: completedCount,
      failedSessions: failedIds,
    });

    if (failedIds.length > 0) {
      await updateStepStatus(gapId, step, { status: 'failed', failureReason: results[failedIds[0] - 1].error });
      await Workflow.updateOne({ gapId }, {
        status: 'failed',
        failureReason: `${step} failed in session(s) ${failedIds.join(', ')}`,
        failedSession: failedIds[0],
      });

      emit({
        type: 'workflow_failed',
        gapId,
        data: {
          step,
          failedSession: failedIds[0],
          failedSessions: failedIds,
          reason: results[failedIds[0] - 1].error,
          message: `${step} failed in session ${failedIds[0]}. Manual check required.`,
        },
      });
    } else {
      await updateStepStatus(gapId, step, { status: 'completed' });

      emit({
        type: 'step_complete',
        gapId,
        data: { step, totalSessions, allPassed: true },
      });

      // Check if ALL steps are done
      const refreshed = await Workflow.findOne({ gapId });
      if (refreshed) {
        const allStatuses = refreshed.stepStatuses as unknown as Record<string, IStepStatus>;
        const allCompleted = Object.values(allStatuses).every(
          (s) => s.status === 'completed' || s.status === 'idle'
        );
        // For Phase 1 only step1 matters
        if (allStatuses?.step1?.status === 'completed') {
          await Workflow.updateOne({ gapId }, { status: 'completed', currentStep: 'done' });
          emit({
            type: 'workflow_completed',
            gapId,
            data: { totalSessions, allPassed: true },
          });
        }
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await updateStepStatus(gapId, step, { status: 'failed', failureReason: errMsg });
    await Workflow.updateOne({ gapId }, { status: 'failed', failureReason: errMsg });

    emit({
      type: 'workflow_failed',
      gapId,
      data: { step, reason: errMsg, message: `Workflow failed: ${errMsg}` },
    });
  }
}

/**
 * Re-run only failed sessions for a step.
 */
export async function rerunFailedSessions(gapId: string, step: string): Promise<void> {
  const workflow = await Workflow.findOne({ gapId });
  if (!workflow) throw new Error(`Workflow ${gapId} not found`);

  const stepStatuses = workflow.stepStatuses as unknown as Record<string, IStepStatus>;
  const stepInfo = stepStatuses?.[step];
  if (!stepInfo || stepInfo.failedSessions.length === 0) {
    throw new Error(`No failed sessions to re-run for ${step}`);
  }

  const failedIds = [...stepInfo.failedSessions];

  // Mark step running again
  await Workflow.updateOne({ gapId }, { status: 'running', currentStep: step });
  await updateStepStatus(gapId, step, { status: 'running' });

  emit({
    type: 'status_change',
    gapId,
    data: { status: 'running', currentStep: step },
  });

  try {
    await wsClient.connect();

    const promptKey = getPromptKey(step);
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | undefined;
    const prompt = buildPrompt(promptKey, workflow.contextBlock, snapshot);

    // Delete old failed outputs
    await StepOutput.deleteMany({
      gapId, step,
      session: { $in: failedIds },
    });

    // Re-run failed sessions
    const results = await Promise.all(
      failedIds.map((sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt))
    );

    // Recount from DB
    const allOutputs = await StepOutput.find({ gapId, step });
    const completedCount = allOutputs.filter((o) => o.validationPassed).length;
    const stillFailed = allOutputs.filter((o) => !o.validationPassed).map((o) => o.session);

    await updateStepStatus(gapId, step, {
      completedSessions: completedCount,
      failedSessions: stillFailed,
    });

    if (stillFailed.length > 0) {
      await updateStepStatus(gapId, step, { status: 'failed' });
      await Workflow.updateOne({ gapId }, {
        status: 'failed',
        failureReason: `${step} still failing in session(s) ${stillFailed.join(', ')}`,
      });

      emit({
        type: 'workflow_failed',
        gapId,
        data: {
          step,
          failedSessions: stillFailed,
          message: `${step} re-run: session(s) ${stillFailed.join(', ')} still failing.`,
        },
      });
    } else {
      await updateStepStatus(gapId, step, { status: 'completed' });
      await Workflow.updateOne({ gapId }, { status: 'completed', currentStep: 'done' });

      emit({
        type: 'step_complete',
        gapId,
        data: { step, allPassed: true },
      });

      emit({
        type: 'workflow_completed',
        gapId,
        data: { allPassed: true },
      });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await updateStepStatus(gapId, step, { status: 'failed', failureReason: errMsg });
    await Workflow.updateOne({ gapId }, { status: 'failed', failureReason: errMsg });

    emit({
      type: 'workflow_failed',
      gapId,
      data: { step, reason: errMsg, message: `Re-run failed: ${errMsg}` },
    });
  }
}

/**
 * Start a full workflow (Step 0 init → Step 1 execution).
 */
export async function startWorkflow(contextBlock: string): Promise<IWorkflow> {
  const gapId = uuidv4();

  // Snapshot current prompts
  const snapshot = { ...promptPlaceholders };

  const workflow = await Workflow.create({
    gapId,
    status: 'running',
    currentStep: 'step0',
    contextBlock,
    promptSnapshot: snapshot,
  });

  console.log(`🚀 [${gapId}] Workflow started`);

  emit({
    type: 'status_change',
    gapId,
    data: { status: 'running', currentStep: 'step0' },
  });

  // Run Step 1 in background
  setImmediate(() => {
    runStep(gapId, 'step1').catch((err) => {
      console.error(`❌ [${gapId}] Step 1 error:`, err.message);
    });
  });

  return workflow;
}

/**
 * Get the current status of a workflow with step outputs.
 */
export async function getWorkflowStatus(gapId: string) {
  const workflow = await Workflow.findOne({ gapId });
  if (!workflow) return null;

  const stepOutputs = await StepOutput.find({ gapId }).sort({ step: 1, session: 1 });

  return {
    gapId: workflow.gapId,
    status: workflow.status,
    currentStep: workflow.currentStep,
    failureReason: workflow.failureReason,
    failedSession: workflow.failedSession,
    stepStatuses: workflow.stepStatuses,
    stepOutputs: stepOutputs.map((s) => ({
      step: s.step,
      session: s.session,
      panel: s.panel,
      validationPassed: s.validationPassed,
      storedInCoda: s.storedInCoda,
      output: s.output,
      createdAt: s.createdAt,
    })),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

/**
 * Get a list of all workflows (for history panel).
 */
export async function listWorkflows() {
  const workflows = await Workflow.find()
    .select('gapId status currentStep createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return workflows.map((w) => ({
    gapId: w.gapId,
    status: w.status,
    currentStep: w.currentStep,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }));
}
