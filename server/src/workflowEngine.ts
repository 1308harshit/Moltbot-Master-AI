import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Workflow, IWorkflow, STEP_PREREQUISITES, IStepStatus } from './models/Workflow';
import { StepOutput } from './models/StepOutput';
import { wsClient } from './wsClient';
import { pushToCoda } from './coda';
import { config, promptPlaceholders } from './config';

/**
 * Track active (running) workflows: gapId → sessionKey.
 * Used by stopWorkflow to mark them failed and by the engine to skip further steps.
 */
const activeWorkflows: Map<string, string> = new Map();

/** Simple delay helper */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is transient and worth retrying */
function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('Timeout waiting for run') ||
    msg.includes("Can't reach the openclaw") ||
    msg.includes('browser control service') ||
    msg.includes('timed out') ||
    msg.includes('WebSocket closed')
  );
}

/** Check if MoltBot's response indicates ANY failure that requires session reset + boot retry. */
function isMoltBotFailureResponse(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('no tab connected') ||
    lower.includes('no tab attached') ||
    lower.includes("can't open") ||
    lower.includes('cannot open') ||
    (lower.includes('relay') && lower.includes('not connected')) ||
    lower.includes('attach a chrome tab') ||
    lower.includes('attach the tab') ||
    lower.includes("can't reach") ||
    lower.includes('cannot reach') ||
    lower.includes('openclaw browser control service') ||
    lower.includes('timing out') ||
    lower.includes('timed out') ||
    lower.includes('aria snapshot') ||
    lower.includes("can't access") ||
    lower.includes("can't interact") ||
    lower.includes("can't complete that step") ||
    lower.includes('what i need from you') ||
    lower.includes('please restart') ||
    lower.includes('please do this') ||
    lower.includes('what do you want') ||
    lower.includes("can't find")
  );
}

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
function buildPrompt(placeholderKey: string, contextBlock: string, snapshot?: Record<string, string> | Map<string, string>): string {
  const source = snapshot || promptPlaceholders;
  
  let template = '';
  if (source instanceof Map) {
    template = source.get(placeholderKey) || `[Missing prompt for ${placeholderKey}]`;
  } else {
    template = (source as Record<string, string>)[placeholderKey] || `[Missing prompt for ${placeholderKey}]`;
  }
  
  if (template.includes('{{CONTEXT_BLOCK}}')) {
    return template.replace('{{CONTEXT_BLOCK}}', contextBlock);
  }
  
  if (contextBlock && placeholderKey !== 'default_prompt_boot') {
    return `${template}\n\n${contextBlock}`;
  }
  
  return template;
}

/**
 * Validate that the response contains the expected end-of-step marker.
 */
function validateMarker(output: string, step: string): boolean {
  const markers: Record<string, string> = {
    step0: '=== END OF STEP 0 ===',  // BOOT — disabled, kept for future use
    step1: 'END OF RESPONSE A',
    step2: '=== END OF STEP 2 ===',
    step3: '=== END OF STEP 3 ===',
    step4: '=== END OF STEP 4 ===',
    step5: 'END OF RESPONSE B',
    step6: '=== END OF STEP 6 ===',
    step7: '=== END OF STEP 7 ===',
    step8: '=== END OF STEP 8 ===',
    step9: '=== END OF STEP 9 ===',
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
    const stepStatuses = (workflow as any).toJSON().stepStatuses as Record<string, IStepStatus>;
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
    // step0: 'default_prompt_boot',  // BOOT — disabled
    step1: 'default_prompt_step1',
    step2: 'default_prompt_step2',
    step3: 'default_prompt_step3',
    step4: 'default_prompt_step4',
    step5: 'default_prompt_step5',
    step6: 'default_prompt_step6',
    step7: 'default_prompt_step7',
    step8: 'default_prompt_step8',
    step9: 'default_prompt_step9',
  };
  return map[step] || `default_prompt_${step}`;
}

/**
 * Run the boot sequence: open browser + 6 AI tabs.
 * DISABLED — workflow starts directly at Step 1.
 * Kept for future use.
 */
/*
async function runBootSequence(
  gapId: string,
  sessionKey: string,
  maxAttempts = 3
): Promise<{ success: boolean; output: string }> {
  let output = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.log(`⏳ [${gapId}] boot retry ${attempt}/${maxAttempts}: sending /new to reset session...`);
      await wsClient.sendToSession(sessionKey, '/new');
      await delay(3000);
    }

    console.log(`🔄 [${gapId}] boot — Open browser + 6 AI tabs${attempt > 0 ? ` [attempt ${attempt + 1}]` : ''}...`);
    output = await wsClient.sendToSession(sessionKey, 'open browser');

    if (isMoltBotFailureResponse(output)) {
      console.log(`⚠️ [${gapId}] boot — Open browser failed: relay not connected`);
      continue;
    }

    return { success: true, output };
  }

  return { success: false, output: 'Boot failed after all retries: OpenClaw Browser Relay not connected.' };
}
*/

/**
 * Execute a single panel session.
 */
async function executePanel(
  gapId: string,
  step: string,
  session: number,
  panelId: number,
  prompt: string,
  sessionKey: string
): Promise<{ success: boolean; output: string; error?: string }> {
  const maxRetries = step === 'step0' ? 0 : config.panelRetryCount;
  const retryDelayMs = config.panelRetryDelayMs;
  const timeoutMs = config.browserStepTimeoutMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`⏳ [${gapId}] ${step} — retry ${attempt}/${maxRetries} in ${retryDelayMs / 1000}s...`);
        await delay(retryDelayMs);
      }

      console.log(`🔄 [${gapId}] ${step} — session ${session}, panel ${panelId}: sending${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);

      if (!activeWorkflows.has(gapId)) {
        return { success: false, output: '', error: 'Workflow was stopped' };
      }

      let output = '';

      // Step 0 boot logic — DISABLED (workflow starts at Step 1)
      // if (step === 'step0') {
      //   const boot = await runBootSequence(gapId, sessionKey);
      //   output = boot.output;
      //   if (boot.success) {
      //     output += '\n=== END OF STEP 0 ===';
      //   }
      // } else {
        output = await wsClient.sendToSession(sessionKey, prompt, timeoutMs);

        if (isMoltBotFailureResponse(output)) {
          console.log(`⚠️ [${gapId}] ${step} — MoltBot failure detected, retrying...`);
          await delay(5000);
          output = await wsClient.sendToSession(sessionKey, prompt, timeoutMs);
        }
      // }

      // Browser-interaction steps (step1, step5, step9) skip strict marker validation
      const skipMarker = step === 'step1' || step === 'step5' || step === 'step9';
      const passed = skipMarker ? true : validateMarker(output, step);

      await StepOutput.create({
        gapId, step, session, panel: panelId,
        output, validationPassed: passed, storedInCoda: false,
      });

      emit({
        type: 'panel_complete',
        gapId,
        data: { step, session, panelId, passed },
      });

      if (!passed && !skipMarker) {
        return {
          success: false, output,
          error: `Validation failed: marker not found in session ${session}`,
        };
      }

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

      if (attempt < maxRetries && isRetryableError(error)) {
        console.log(`⚠️ [${gapId}] ${step} — transient error: ${errMsg}`);
        await StepOutput.deleteMany({ gapId, step, session, panel: panelId });
        continue;
      }

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

  return { success: false, output: '', error: 'Exhausted all retry attempts' };
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

  if (!activeWorkflows.has(gapId)) {
    console.log(`⛔ [${gapId}] ${step} — workflow stopped, skipping step.`);
    return;
  }

  const check = canRunStep(workflow, step);
  if (!check.allowed) {
    throw new Error(check.reason!);
  }

  const sessionKey = workflow.sessionKey || 'agent:main:main';
  const totalSessions = 1;

  await Workflow.updateOne({ gapId }, { currentStep: step, status: 'running' });
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
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | Map<string, string> | undefined;
    const context = step === 'step0' ? '' : workflow.contextBlock;
    let prompt = buildPrompt(promptKey, context, snapshot);

    // ═══════════════════════════════════════════
    // Inject downstream outputs
    // ═══════════════════════════════════════════
    if (step === 'step2') {
      // Inject Step 1 output (raw 6-tab responses)
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      prompt = prompt.replace('{{STEP1_OUTPUT}}', step1Out?.output || 'No Step 1 output found.');

    } else if (step === 'step3') {
      // VOTE: Inject cross-review from Step 2
      const step2Out = await StepOutput.findOne({ gapId, step: 'step2', validationPassed: true });
      prompt = prompt.replace('{{STEP2_OUTPUT}}', step2Out?.output || 'No Step 2 output found.');

    } else if (step === 'step4') {
      // FINALIZE R1: Inject Step 1 + Step 2 + Step 3 (vote)
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      const step2Out = await StepOutput.findOne({ gapId, step: 'step2', validationPassed: true });
      const step3Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      prompt = prompt.replace('{{STEP1_OUTPUT}}', step1Out?.output || 'No Step 1 output found.');
      prompt = prompt.replace('{{STEP2_OUTPUT}}', step2Out?.output || 'No Step 2 output found.');
      prompt = prompt.replace('{{STEP3_OUTPUT}}', step3Out?.output || 'No Step 3 output found.');

    } else if (step === 'step5') {
      // GAP QUERY: Inject context from Step 1 + Gap List from Step 4
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      const step4Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const step4Text = step4Out?.output || '';
      const gapMatch = step4Text.match(/(?:Gap List|gap list|Gaps?|Remaining).*?\n([\s\S]*?)(?:===|$)/i);
      const gapList = gapMatch ? gapMatch[1].trim() : step4Text;
      prompt = prompt.replace('{{STEP1_CONTEXT}}', step1Out?.output || 'No research context available.');
      prompt = prompt.replace('{{GAP_LIST}}', gapList);

    } else if (step === 'step6') {
      // EVALUATE GAPS: Inject Round 1 output (Step 4) + Step 5 gap responses
      const round1Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const step5Out = await StepOutput.findOne({ gapId, step: 'step5', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No Round 1 output found.');
      prompt = prompt.replace('{{STEP5_OUTPUT}}', step5Out?.output || 'No Step 5 output found.');

    } else if (step === 'step7') {
      // VOTE GAPS: Inject gap analysis from Step 6
      const step6Out = await StepOutput.findOne({ gapId, step: 'step6', validationPassed: true });
      prompt = prompt.replace('{{STEP6_OUTPUT}}', step6Out?.output || 'No Step 6 output found.');

    } else if (step === 'step8') {
      // FINAL REPORT: Inject Round 1 (Step 4) + Gap Analysis (Step 6) + Gap Quality (Step 7)
      const round1Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const gapAnalysis = await StepOutput.findOne({ gapId, step: 'step6', validationPassed: true });
      const gapQuality = await StepOutput.findOne({ gapId, step: 'step7', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No Round 1 output found.');
      prompt = prompt.replace('{{GAP_ANALYSIS}}', gapAnalysis?.output || 'No gap analysis found.');
      prompt = prompt.replace('{{GAP_QUALITY}}', gapQuality?.output || 'No gap quality evaluation found.');
    }

    // Launch sessions
    const results = await Promise.all(
      Array.from({ length: totalSessions }, (_, i) => i + 1).map(
        (sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt, sessionKey)
      )
    );

    let completedCount = 0;
    const failedIds: number[] = [];

    results.forEach((r, idx) => {
      if (r.success) {
        completedCount++;
      } else {
        failedIds.push(idx + 1);
      }
    });

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

      // ═══════════════════════════════════════════
      // Auto-chain: step0→1→2→3→4→5→6→7→8→9→done
      // ═══════════════════════════════════════════
      const nextStepMap: Record<string, string | null> = {
        // step0: null,     // BOOT — disabled
        step1: 'step2',
        step2: 'step3',
        step3: 'step4',
        step4: 'step5',
        step5: 'step6',
        step6: 'step7',
        step7: 'step8',
        step8: 'step9',
        step9: null,     // workflow complete
      };

      const nextStep = nextStepMap[step];

      if (step === 'step9') {
        activeWorkflows.delete(gapId);
        await Workflow.updateOne({ gapId }, { status: 'completed', currentStep: 'done' });
        emit({
          type: 'workflow_completed',
          gapId,
          data: { totalSessions, allPassed: true },
        });
      } else if (nextStep) {
        setImmediate(() => {
          runStep(gapId, nextStep).catch(e => console.error(`Auto-chain ${nextStep} failed:`, e.message));
        });
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

  const stepStatuses = (workflow as any).toJSON().stepStatuses as Record<string, IStepStatus>;
  const stepInfo = stepStatuses?.[step];
  if (!stepInfo || stepInfo.failedSessions.length === 0) {
    throw new Error(`No failed sessions to re-run for ${step}`);
  }

  const failedIds = [...stepInfo.failedSessions];

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
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | Map<string, string> | undefined;
    let prompt = buildPrompt(promptKey, workflow.contextBlock, snapshot);

    // Inject downstream outputs (same logic as runStep)
    if (step === 'step2') {
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      prompt = prompt.replace('{{STEP1_OUTPUT}}', step1Out?.output || 'No Step 1 output found.');
    } else if (step === 'step3') {
      const step2Out = await StepOutput.findOne({ gapId, step: 'step2', validationPassed: true });
      prompt = prompt.replace('{{STEP2_OUTPUT}}', step2Out?.output || 'No Step 2 output found.');
    } else if (step === 'step4') {
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      const step2Out = await StepOutput.findOne({ gapId, step: 'step2', validationPassed: true });
      const step3Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      prompt = prompt.replace('{{STEP1_OUTPUT}}', step1Out?.output || 'No Step 1 output found.');
      prompt = prompt.replace('{{STEP2_OUTPUT}}', step2Out?.output || 'No Step 2 output found.');
      prompt = prompt.replace('{{STEP3_OUTPUT}}', step3Out?.output || 'No Step 3 output found.');
    } else if (step === 'step5') {
      const step1Out = await StepOutput.findOne({ gapId, step: 'step1', validationPassed: true });
      const step4Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const step4Text = step4Out?.output || '';
      const gapMatch = step4Text.match(/(?:Gap List|gap list|Gaps?|Remaining).*?\n([\s\S]*?)(?:===|$)/i);
      const gapList = gapMatch ? gapMatch[1].trim() : step4Text;
      prompt = prompt.replace('{{STEP1_CONTEXT}}', step1Out?.output || 'No research context available.');
      prompt = prompt.replace('{{GAP_LIST}}', gapList);
    } else if (step === 'step6') {
      const round1Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const step5Out = await StepOutput.findOne({ gapId, step: 'step5', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No Round 1 output found.');
      prompt = prompt.replace('{{STEP5_OUTPUT}}', step5Out?.output || 'No Step 5 output found.');
    } else if (step === 'step7') {
      const step6Out = await StepOutput.findOne({ gapId, step: 'step6', validationPassed: true });
      prompt = prompt.replace('{{STEP6_OUTPUT}}', step6Out?.output || 'No Step 6 output found.');
    } else if (step === 'step8') {
      const round1Out = await StepOutput.findOne({ gapId, step: 'step4', validationPassed: true });
      const gapAnalysis = await StepOutput.findOne({ gapId, step: 'step6', validationPassed: true });
      const gapQuality = await StepOutput.findOne({ gapId, step: 'step7', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No Round 1 output found.');
      prompt = prompt.replace('{{GAP_ANALYSIS}}', gapAnalysis?.output || 'No gap analysis found.');
      prompt = prompt.replace('{{GAP_QUALITY}}', gapQuality?.output || 'No gap quality evaluation found.');
    }

    await StepOutput.deleteMany({
      gapId, step,
      session: { $in: failedIds },
    });

    const sessionKey = workflow.sessionKey || 'agent:main:main';
    const results = await Promise.all(
      failedIds.map((sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt, sessionKey))
    );

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
 * Start a full workflow (Step 0 init → auto-chain through all steps).
 */
export async function startWorkflow(contextBlock: string): Promise<IWorkflow> {
  const gapId = uuidv4();
  const sessionKey = `agent:workflow:${gapId}`;
  const snapshot = { ...promptPlaceholders };

  const workflow = await Workflow.create({
    gapId,
    sessionKey,
    status: 'running',
    currentStep: 'step1',  // Skip step0, start at step1
    contextBlock,
    promptSnapshot: snapshot,
  });

  activeWorkflows.set(gapId, sessionKey);
  console.log(`🚀 [${gapId}] Workflow started (session: ${sessionKey})`);

  emit({
    type: 'status_change',
    gapId,
    data: { status: 'running', currentStep: 'step1' },
  });

  // Workflow starts directly at Step 1 (no boot step)
  setImmediate(() => {
    runStep(gapId, 'step1')
      .catch((err) => {
        console.error(`❌ [${gapId}] Step 1 error:`, err.message);
      });
  });

  return workflow;
}

/**
 * Stop a running workflow immediately.
 */
export async function stopWorkflow(gapId: string): Promise<void> {
  const isActive = activeWorkflows.has(gapId);
  activeWorkflows.delete(gapId);

  if (!isActive) {
    const wf = await Workflow.findOne({ gapId });
    if (!wf) throw new Error(`Workflow ${gapId} not found`);
    if (wf.status !== 'running') throw new Error(`Workflow ${gapId} is not running (status: ${wf.status})`);
  }

  await Workflow.updateOne(
    { gapId },
    { status: 'failed', failureReason: 'Stopped by user' }
  );

  emit({
    type: 'workflow_failed',
    gapId,
    data: { reason: 'Stopped by user', message: 'Workflow was manually stopped.' },
  });

  console.log(`⛔ [${gapId}] Workflow stopped by user.`);
}

/**
 * Delete a workflow and all its step outputs from MongoDB.
 */
export async function deleteWorkflow(gapId: string): Promise<void> {
  if (activeWorkflows.has(gapId)) {
    activeWorkflows.delete(gapId);
  }

  await StepOutput.deleteMany({ gapId });
  await Workflow.deleteOne({ gapId });

  console.log(`🗑️ [${gapId}] Workflow and all outputs deleted.`);
}

/**
 * Get the current status of a workflow with step outputs.
 */
export async function getWorkflowStatus(gapId: string) {
  const workflow = await Workflow.findOne({ gapId });
  if (!workflow) throw new Error(`Workflow ${gapId} not found`);

  const stepOutputs = await StepOutput.find({ gapId }).sort({ step: 1, session: 1, panel: 1 });

  return {
    gapId: workflow.gapId,
    sessionKey: workflow.sessionKey,
    status: workflow.status,
    currentStep: workflow.currentStep,
    contextBlock: workflow.contextBlock,
    failureReason: workflow.failureReason,
    failedSession: workflow.failedSession,
    stepStatuses: (workflow as any).toJSON().stepStatuses,
    stepOutputs: stepOutputs.map((o) => ({
      step: o.step,
      session: o.session,
      panel: o.panel,
      validationPassed: o.validationPassed,
      storedInCoda: o.storedInCoda,
      output: o.output,
      createdAt: o.createdAt,
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
    .sort({ createdAt: -1 });
  return workflows.map((w) => ({
    gapId: w.gapId,
    status: w.status,
    currentStep: w.currentStep,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }));
}
