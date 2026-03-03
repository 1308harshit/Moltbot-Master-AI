import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Workflow, IWorkflow, STEP_PREREQUISITES, IStepStatus } from './models/Workflow';
import { StepOutput } from './models/StepOutput';
import { wsClient } from './wsClient';
import { pushToCoda } from './coda';
import { config, promptPlaceholders } from './config';

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

/** Check if MoltBot's response indicates ANY failure that requires session reset + boot retry.
 *  Covers: relay disconnected, ARIA/DOM inaccessible, browser control service down, timeouts, extension not found. */
function isMoltBotFailureResponse(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    // Relay not connected
    lower.includes('no tab connected') ||
    lower.includes('no tab attached') ||
    lower.includes("can't open") ||
    lower.includes('cannot open') ||
    (lower.includes('relay') && lower.includes('not connected')) ||
    lower.includes('attach a chrome tab') ||
    lower.includes('attach the tab') ||
    // Browser control service unreachable / timing out
    lower.includes("can't reach") ||
    lower.includes('cannot reach') ||
    lower.includes('openclaw browser control service') ||
    lower.includes('timing out') ||
    lower.includes('timed out') ||
    // UI interaction failures (ARIA/DOM issues)
    lower.includes('aria snapshot') ||
    lower.includes('dom queries return zero') ||
    lower.includes("can't access") ||
    lower.includes("can't interact") ||
    lower.includes("can't reliably click") ||
    lower.includes("can't complete that step") ||
    lower.includes('zero inputs') ||
    lower.includes('image-only') ||
    // MoltBot asking user to do it manually / extension not found
    lower.includes('what i need from you') ||
    lower.includes('please restart') ||
    lower.includes('please do this') ||
    lower.includes('what do you want') ||
    lower.includes('not installed') ||
    lower.includes('no search results') ||
    lower.includes("isn't installed") ||
    lower.includes('no extension') ||
    lower.includes('install chathub') ||
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
  
  // If no context placeholder, just append it if we have context (except for step0)
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
    step0: '=== END OF STEP 0 ===',
    step1: '=== END OF STEP 1 ===',
    step2a: '=== END OF STEP 2A ===',
    step2b: '=== END OF STEP 2B ===',
    step2c: '=== END OF STEP 2C ===',
    step3: '=== END OF STEP 3 ===',
    step4: '=== END OF STEP 4 ===',
    step5a: '=== END OF STEP 5A ===',
    step5b: '=== END OF STEP 5B ===',
    step5c: '=== END OF STEP 5C ===',
    step6: '=== END OF STEP 6 ===',
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
    step0: 'default_prompt_boot',
    step1: 'default_prompt_step1',
    step2a: 'default_prompt_step2a',
    step2b: 'default_prompt_step2b',
    step2c: 'default_prompt_step2c',
    step3: 'default_prompt_step3',
    step4: 'default_prompt_step4',
    step5a: 'default_prompt_step5a',
    step5b: 'default_prompt_step5b',
    step5c: 'default_prompt_step5c',
    step6: 'default_prompt_step6',
  };
  return map[step] || `default_prompt_${step}`;
}

/**
 * Run the boot sequence: /new (if retry) → open browser → open simple chathub extension ui.
 * Returns { success, output } indicating whether the boot succeeded.
 */
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

    console.log(`🔄 [${gapId}] boot — Open browser${attempt > 0 ? ` [attempt ${attempt + 1}]` : ''}...`);
    const browserOutput = await wsClient.sendToSession(sessionKey, 'open browser');

    if (isMoltBotFailureResponse(browserOutput)) {
      console.log(`⚠️ [${gapId}] boot — Open browser failed: relay not connected`);
      continue;
    }

    console.log(`🔄 [${gapId}] boot — Open Simple Chat Hub extension${attempt > 0 ? ` [attempt ${attempt + 1}]` : ''}...`);
    output = await wsClient.sendToSession(sessionKey, 'open the extension called "Simple Chat Hub" - it is a chrome extension that has 6 AI chat panels. Open its main UI page.');

    if (isMoltBotFailureResponse(output)) {
      console.log(`⚠️ [${gapId}] boot — Open extension failed: relay not connected`);
      continue;
    }

    // Both commands succeeded
    return { success: true, output };
  }

  return { success: false, output: 'Boot failed after all retries: OpenClaw Browser Relay not connected.' };
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

      const sessionKey = 'agent:main:main';
      let output = '';

      if (step === 'step0') {
        // Step 0: run the full boot sequence
        const boot = await runBootSequence(gapId, sessionKey);
        output = boot.output;
        if (boot.success) {
          output += '\n=== END OF STEP 0 ===';
        }
      } else {
        output = await wsClient.sendToSession(sessionKey, prompt, timeoutMs);

        // If MoltBot says "no tab connected", run the full boot sequence first, then retry the step
        if (isMoltBotFailureResponse(output)) {
          console.log(`⚠️ [${gapId}] ${step} — no tab connected, running full boot sequence before retrying...`);
          const boot = await runBootSequence(gapId, sessionKey);
          if (boot.success) {
            await delay(2000);
            console.log(`🔄 [${gapId}] ${step} — boot recovered, retrying step prompt...`);
            output = await wsClient.sendToSession(sessionKey, prompt, timeoutMs);
          } else {
            output = boot.output;
          }
        }
      }

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

      // If retryable and we have attempts left, log and continue the loop
      if (attempt < maxRetries && isRetryableError(error)) {
        console.log(`⚠️ [${gapId}] ${step} — transient error: ${errMsg}`);
        // Clean up any partial output before retrying
        await StepOutput.deleteMany({ gapId, step, session, panel: panelId });
        continue;
      }

      // Final failure — store error and emit
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

  // Should never reach here, but just in case
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

  // Enforce step locking
  const check = canRunStep(workflow, step);
  if (!check.allowed) {
    throw new Error(check.reason!);
  }

  // Since all steps now execute in the main session automatically waiting for generation, 
  // totalSessions per step should just be 1, because 1 request is sent to the active tab which handles all panels inside its own React UI.
  // We keep tracking totalSessions logic but clamp it to 1 to signify 1 step execution request = 1 phase completed.
  const totalSessions = 1;

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
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | Map<string, string> | undefined;
    const context = step === 'step0' ? '' : workflow.contextBlock;
    let prompt = buildPrompt(promptKey, context, snapshot);

    // Inject downstream outputs for Step 2b, 2c, 3, 4, 5b, 5c, 6
    // Note: Step 2a and 5a read panel outputs directly via MoltBot browser interaction
    if (step === 'step2b') {
      const step2aOuts = await StepOutput.find({ gapId, step: 'step2a', validationPassed: true }).sort({ session: 1 });
      const combined = step2aOuts.map(o => `--- Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP2A_OUTPUTS}}', combined);
    } else if (step === 'step2c') {
      const step2bOuts = await StepOutput.find({ gapId, step: 'step2b', validationPassed: true }).sort({ session: 1 });
      const combined = step2bOuts.map(o => `--- Consolidated Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP2B_OUTPUTS}}', combined);
    } else if (step === 'step3') {
      const step2cOuts = await StepOutput.find({ gapId, step: 'step2c', validationPassed: true }).sort({ session: 1 });
      const analysisOutput = await StepOutput.findOne({ gapId, step: 'step2b', validationPassed: true });
      const qualityEval = step2cOuts.map(o => o.output).join('\n\n');
      prompt = prompt.replace('{{ANALYSIS_INPUT}}', analysisOutput?.output || 'No analysis found.');
      prompt = prompt.replace('{{QUALITY_EVALUATION}}', qualityEval);
    } else if (step === 'step4') {
      // Inject Step 2a output (analysis context) + Gap List from Step 3
      const step2aOut = await StepOutput.findOne({ gapId, step: 'step2a', validationPassed: true });
      const step3Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      const step3Text = step3Out?.output || '';
      // Extract gap list section from step3 output
      const gapMatch = step3Text.match(/(?:Gap List|gap list|Gaps?|Remaining).*?\n([\s\S]*?)(?:===|$)/i);
      const gapList = gapMatch ? gapMatch[1].trim() : step3Text;
      prompt = prompt.replace('{{STEP2A_CONTEXT}}', step2aOut?.output || 'No analysis context available.');
      prompt = prompt.replace('{{GAP_LIST}}', gapList);
    } else if (step === 'step5b') {
      // Inject Step 5a outputs + Round 1 output for context
      const step5aOuts = await StepOutput.find({ gapId, step: 'step5a', validationPassed: true }).sort({ session: 1 });
      const combined = step5aOuts.map(o => `--- Gap Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      const round1Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No round 1 output found.');
      prompt = prompt.replace('{{STEP5A_OUTPUTS}}', combined);
    } else if (step === 'step5c') {
      const step5bOuts = await StepOutput.find({ gapId, step: 'step5b', validationPassed: true }).sort({ session: 1 });
      const combined = step5bOuts.map(o => `--- Consolidated Gap Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP5B_OUTPUTS}}', combined);
    } else if (step === 'step6') {
      const round1Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      const gapAnalysis = await StepOutput.findOne({ gapId, step: 'step5b', validationPassed: true });
      const step5cOuts = await StepOutput.find({ gapId, step: 'step5c', validationPassed: true }).sort({ session: 1 });
      const gapQualityEval = step5cOuts.map(o => o.output).join('\n\n');
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No round 1 output found.');
      prompt = prompt.replace('{{GAP_ANALYSIS_INPUT}}', gapAnalysis?.output || 'No gap analysis found.');
      prompt = prompt.replace('{{GAP_QUALITY_EVALUATION}}', gapQualityEval);
    }

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
        const allStatuses = (refreshed as any).toJSON().stepStatuses as Record<string, IStepStatus>;
        const allCompleted = Object.values(allStatuses).every(
          (s) => s.status === 'completed' || s.status === 'idle'
        );

        // Auto-chain next steps sequentially
        if (step === 'step0') {
          // Already handled in startWorkflow
        } else if (step === 'step1') {
          setImmediate(() => {
            runStep(gapId, 'step2a').catch(e => console.error(`Auto-chain 2a failed:`, e.message));
          });
        } else if (step === 'step2a') {
          setImmediate(() => {
            runStep(gapId, 'step2b').catch(e => console.error(`Auto-chain 2b failed:`, e.message));
          });
        } else if (step === 'step2b') {
          setImmediate(() => {
            runStep(gapId, 'step2c').catch(e => console.error(`Auto-chain 2c failed:`, e.message));
          });
        } else if (step === 'step2c') {
          setImmediate(() => {
            runStep(gapId, 'step3').catch(e => console.error(`Auto-chain 3 failed:`, e.message));
          });
        } else if (step === 'step3') {
          // Round 1 done — continue to Round 2 (Gap Research)
          console.log(`🔄 [${gapId}] Round 1 complete. Starting Round 2 (Gap Research)...`);
          setImmediate(() => {
            runStep(gapId, 'step4').catch(e => console.error(`Auto-chain 4 failed:`, e.message));
          });
        } else if (step === 'step4') {
          setImmediate(() => {
            runStep(gapId, 'step5a').catch(e => console.error(`Auto-chain 5a failed:`, e.message));
          });
        } else if (step === 'step5a') {
          setImmediate(() => {
            runStep(gapId, 'step5b').catch(e => console.error(`Auto-chain 5b failed:`, e.message));
          });
        } else if (step === 'step5b') {
          setImmediate(() => {
            runStep(gapId, 'step5c').catch(e => console.error(`Auto-chain 5c failed:`, e.message));
          });
        } else if (step === 'step5c') {
          setImmediate(() => {
            runStep(gapId, 'step6').catch(e => console.error(`Auto-chain 6 failed:`, e.message));
          });
        } else if (step === 'step6') {
           // Entire workflow (both rounds) is finished
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

  const stepStatuses = (workflow as any).toJSON().stepStatuses as Record<string, IStepStatus>;
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
    const snapshot = workflow.promptSnapshot as unknown as Record<string, string> | Map<string, string> | undefined;
    let prompt = buildPrompt(promptKey, workflow.contextBlock, snapshot);

    // Inject downstream outputs for Step 2b, 2c, 3, 4, 5b, 5c, 6
    // Note: Step 2a and 5a read panel outputs directly via MoltBot browser interaction
    if (step === 'step2b') {
      const step2aOuts = await StepOutput.find({ gapId, step: 'step2a', validationPassed: true }).sort({ session: 1 });
      const combined = step2aOuts.map(o => `--- Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP2A_OUTPUTS}}', combined);
    } else if (step === 'step2c') {
      const step2bOuts = await StepOutput.find({ gapId, step: 'step2b', validationPassed: true }).sort({ session: 1 });
      const combined = step2bOuts.map(o => `--- Consolidated Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP2B_OUTPUTS}}', combined);
    } else if (step === 'step3') {
      const step2cOuts = await StepOutput.find({ gapId, step: 'step2c', validationPassed: true }).sort({ session: 1 });
      const analysisOutput = await StepOutput.findOne({ gapId, step: 'step2b', validationPassed: true });
      const qualityEval = step2cOuts.map(o => o.output).join('\n\n');
      prompt = prompt.replace('{{ANALYSIS_INPUT}}', analysisOutput?.output || 'No analysis found.');
      prompt = prompt.replace('{{QUALITY_EVALUATION}}', qualityEval);
    } else if (step === 'step4') {
      const step3Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      const step3Text = step3Out?.output || '';
      const gapMatch = step3Text.match(/(?:Gap List|gap list|Gaps?|Remaining).*?\n([\s\S]*?)(?:===|$)/i);
      const gapList = gapMatch ? gapMatch[1].trim() : step3Text;
      prompt = prompt.replace('{{GAP_LIST}}', gapList);
    } else if (step === 'step5b') {
      const step5aOuts = await StepOutput.find({ gapId, step: 'step5a', validationPassed: true }).sort({ session: 1 });
      const combined = step5aOuts.map(o => `--- Gap Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      const round1Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No round 1 output found.');
      prompt = prompt.replace('{{STEP5A_OUTPUTS}}', combined);
    } else if (step === 'step5c') {
      const step5bOuts = await StepOutput.find({ gapId, step: 'step5b', validationPassed: true }).sort({ session: 1 });
      const combined = step5bOuts.map(o => `--- Consolidated Gap Analysis ${o.session} ---\n${o.output}`).join('\n\n');
      prompt = prompt.replace('{{STEP5B_OUTPUTS}}', combined);
    } else if (step === 'step6') {
      const round1Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      const gapAnalysis = await StepOutput.findOne({ gapId, step: 'step5b', validationPassed: true });
      const step5cOuts = await StepOutput.find({ gapId, step: 'step5c', validationPassed: true }).sort({ session: 1 });
      const gapQualityEval = step5cOuts.map(o => o.output).join('\n\n');
      prompt = prompt.replace('{{ROUND1_OUTPUT}}', round1Out?.output || 'No round 1 output found.');
      prompt = prompt.replace('{{GAP_ANALYSIS_INPUT}}', gapAnalysis?.output || 'No gap analysis found.');
      prompt = prompt.replace('{{GAP_QUALITY_EVALUATION}}', gapQualityEval);
    }

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

  // Run Step 0 (boot) in background, then Step 1
  setImmediate(() => {
    runStep(gapId, 'step0')
      .then(() => {
        console.log(`⏳ [${gapId}] Waiting ${config.stepTransitionDelayMs / 1000}s for browser control service to stabilize...`);
        return delay(config.stepTransitionDelayMs);
      })
      .then(() => runStep(gapId, 'step1'))
      .catch((err) => {
        console.error(`❌ [${gapId}] Boot/Step error:`, err.message);
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
