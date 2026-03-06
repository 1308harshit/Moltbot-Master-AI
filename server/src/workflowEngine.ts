import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import WebSocket from 'ws';
import { Workflow, IWorkflow, STEP_PREREQUISITES, IStepStatus } from './models/Workflow';
import { StepOutput } from './models/StepOutput';
import { wsClient } from './wsClient';
import { pushToCoda } from './coda';
import { config, promptPlaceholders } from './config';

const execAsync = promisify(exec);

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
    step0:  '=== END OF STEP 0 ===',
    step1b: '=== END OF STEP 1B ===',
    step2a: '=== END OF STEP 2A ===',
    step2b: '=== END OF STEP 2B ===',
    step2c: '=== END OF STEP 2C ===',
    step3:  '=== END OF STEP 3 ===',
    step4b: '=== END OF STEP 4B ===',
    step5a: '=== END OF STEP 5A ===',
    step5b: '=== END OF STEP 5B ===',
    step5c: '=== END OF STEP 5C ===',
    step6:  '=== END OF STEP 6 ===',
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
    step0:  'default_prompt_boot',
    step1a: 'default_prompt_step1a',
    step1b: 'default_prompt_step1b',
    step2a: 'default_prompt_step2a',
    step2b: 'default_prompt_step2b',
    step2c: 'default_prompt_step2c',
    step3:  'default_prompt_step3',
    step4a: 'default_prompt_step4a',
    step4b: 'default_prompt_step4b',
    step5a: 'default_prompt_step5a',
    step5b: 'default_prompt_step5b',
    step5c: 'default_prompt_step5c',
    step6:  'default_prompt_step6',
  };
  return map[step] || `default_prompt_${step}`;
}

/**
 * Execute the OS command to close the browser.
 */
async function closeBrowser(gapId: string): Promise<void> {
  if (!config.browserCloseCmd) return;
  console.log(`🧹 [${gapId}] Executing browser close command...`);
  try {
    await execAsync(config.browserCloseCmd);
    console.log(`✅ [${gapId}] Browser close command executed successfully.`);
  } catch (err: any) {
    console.error(`⚠️ [${gapId}] Failed to execute browser close command:`, err.message);
  }
}

/**
 * Use Chrome DevTools Protocol (CDP) to type a query into the Simple Chat Hub
 * search bar and press Enter. Connects to Chrome via the debugging port.
 */
async function typeQueryViaCDP(
  gapId: string,
  query: string,
  cdpPort = 18800,
  maxRetries = 5
): Promise<{ success: boolean; error?: string }> {

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`⏳ [${gapId}] CDP retry ${attempt}/${maxRetries}...`);
      await delay(3000);
    }

    try {
      // ── Find the chatHub tab ──
      console.log(`🔍 [${gapId}] CDP — Fetching tab list from http://127.0.0.1:${cdpPort}/json ...`);
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const tabs = (await response.json()) as Array<{ id: string; url: string; webSocketDebuggerUrl?: string; title?: string }>;

      const chatHubTab = tabs.find(t => t.url.includes('chatHub') || t.url.includes('simple-chat-hub') || t.url.includes(config.extensionId));
      if (!chatHubTab || !chatHubTab.webSocketDebuggerUrl) {
        console.log(`⚠️ [${gapId}] CDP — chatHub tab not found. Tabs: ${tabs.map(t => t.url).join(', ')}`);
        continue;
      }

      console.log(`✅ [${gapId}] CDP — Found chatHub tab: ${chatHubTab.url}`);

      // ── Connect to the tab via WebSocket ──
      const ws = new WebSocket(chatHubTab.webSocketDebuggerUrl);
      let msgId = 1;

      const cdpSend = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        return new Promise((resolve, reject) => {
          const id = msgId++;
          const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);

          const handler = (data: any) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          };

          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 5000);
      });

      console.log(`🔌 [${gapId}] CDP — Connected to chatHub tab WebSocket`);

      // ── Focus the textarea ──
      console.log(`🔍 [${gapId}] CDP — Focusing textarea...`);
      const focusResult = await cdpSend('Runtime.evaluate', {
        expression: `(function(){
          var ta = document.querySelector('textarea.ant-input');
          if (!ta) return 'NO_TEXTAREA';
          ta.focus();
          ta.click();
          return 'FOCUSED';
        })()`,
        returnByValue: true,
      });
      console.log(`✅ [${gapId}] CDP — Focus result:`, focusResult?.result?.value);

      if (focusResult?.result?.value === 'NO_TEXTAREA') {
        console.log(`⚠️ [${gapId}] CDP — Textarea not found on page. Retrying...`);
        ws.close();
        continue;
      }

      await delay(300);

      // ── Type the query using native CDP Input.insertText ──
      console.log(`📝 [${gapId}] CDP — Typing query via Input.insertText: "${query.substring(0, 60)}..."`);
      await cdpSend('Input.insertText', { text: query });
      console.log(`✅ [${gapId}] CDP — Text inserted!`);

      await delay(500);

      // ── Verify the value was set ──
      const verifyResult = await cdpSend('Runtime.evaluate', {
        expression: `(function(){
          var ta = document.querySelector('textarea.ant-input');
          return ta ? 'VALUE:' + ta.value.substring(0, 50) : 'NO_TEXTAREA';
        })()`,
        returnByValue: true,
      });
      console.log(`📋 [${gapId}] CDP — Verify:`, verifyResult?.result?.value);

      await delay(500);

      // ── Press Enter using native CDP Input.dispatchKeyEvent ──
      console.log(`🚀 [${gapId}] CDP — Pressing Enter via Input.dispatchKeyEvent...`);
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      console.log(`✅ [${gapId}] CDP — Enter pressed! Query submitted.`);

      ws.close();
      return { success: true };

    } catch (err: any) {
      console.error(`⚠️ [${gapId}] CDP attempt ${attempt + 1} failed:`, err.message);
    }
  }

  return { success: false, error: 'CDP failed after all retries' };
}

/**
 * Panel domain → display name mapping for identifying AI service tabs in CDP.
 */
const PANEL_DOMAINS = [
  { domain: 'chatgpt.com', name: 'ChatGPT' },
  { domain: 'gemini.google.com', name: 'Gemini' },
  { domain: 'grok.com', name: 'Grok' },
  { domain: 'claude.ai', name: 'Claude' },
  { domain: 'perplexity.ai', name: 'Perplexity' },
  { domain: 'chat.qwen.ai', name: 'Qwen' },
];

/**
 * Use CDP to read the response text from each of the 6 AI panel tabs.
 * Each panel in Simple Chat Hub shows up as a separate tab in CDP's /json list.
 * We connect to each tab's WebSocket and run document.body.innerText.
 */
async function readPanelResponsesViaCDP(
  gapId: string,
  cdpPort = config.cdpPort,
  maxRetries = 3
): Promise<{ success: boolean; responses: Record<string, string>; formatted: string }> {
  const responses: Record<string, string> = {};

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`⏳ [${gapId}] CDP read retry ${attempt}/${maxRetries}...`);
      await delay(3000);
    }

    try {
      console.log(`🔍 [${gapId}] CDP — Fetching tab list for panel reading...`);
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const tabs = (await response.json()) as Array<{ url: string; webSocketDebuggerUrl?: string; title?: string }>;

      let foundCount = 0;

      for (const panel of PANEL_DOMAINS) {
        const matchingTab = tabs.find(t => t.url.includes(panel.domain) && t.webSocketDebuggerUrl);
        if (!matchingTab) {
          console.log(`⚠️ [${gapId}] CDP — No tab found for ${panel.name}`);
          responses[panel.name] = 'No visible response.';
          continue;
        }

        try {
          const ws = new WebSocket(matchingTab.webSocketDebuggerUrl!);
          let msgId = 1;

          const cdpSend = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
            return new Promise((resolve, reject) => {
              const id = msgId++;
              const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
              const handler = (data: any) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                  clearTimeout(timeout);
                  ws.off('message', handler);
                  if (msg.error) reject(new Error(msg.error.message));
                  else resolve(msg.result);
                }
              };
              ws.on('message', handler);
              ws.send(JSON.stringify({ id, method, params }));
            });
          };

          await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 5000);
          });

          const result = await cdpSend('Runtime.evaluate', {
            expression: 'document.body ? document.body.innerText : ""',
            returnByValue: true,
          });

          const text = result?.result?.value || '';
          responses[panel.name] = text.trim() || 'No visible response.';
          foundCount++;

          console.log(`✅ [${gapId}] CDP — ${panel.name}: ${text.length} chars`);
          ws.close();
        } catch (err: any) {
          console.error(`⚠️ [${gapId}] CDP — Error reading ${panel.name}:`, err.message);
          responses[panel.name] = 'No visible response.';
        }
      }

      console.log(`📊 [${gapId}] CDP — Read ${foundCount}/${PANEL_DOMAINS.length} panels`);

      // Format the responses for downstream prompts
      const formatted = PANEL_DOMAINS.map(p => {
        return `${p.name} Full Response:\n${responses[p.name]}`;
      }).join('\n\n');

      return { success: true, responses, formatted };

    } catch (err: any) {
      console.error(`⚠️ [${gapId}] CDP read attempt ${attempt + 1} failed:`, err.message);
    }
  }

  return { success: false, responses, formatted: '' };
}

/**
 * Run the boot sequence:
 *  1. Execute the OS command to open Chrome directly to the Simple Chat Hub extension page.
 *  2. Use CDP to type the context block into the search bar and press Enter.
 * Returns { success, output } indicating whether the boot succeeded.
 */
async function runBootSequence(
  gapId: string,
  sessionKey: string,
  maxAttempts = 3,
  contextBlock?: string
): Promise<{ success: boolean; output: string }> {
  // ── Step A: Open Chrome natively via spawn (fire-and-forget) ──
  const chromeArgs = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.openclawUserDataDir}`,
    `chrome-extension://${config.extensionId}/chatHub.html`,
  ];
  console.log(`🚀 [${gapId}] boot — Spawning Chrome: ${config.chromeExePath} ${chromeArgs.join(' ')}`);

  try {
    const { spawn } = await import('child_process');
    const chromeProcess = spawn(config.chromeExePath, chromeArgs, {
      detached: true,
      stdio: 'ignore',
    });
    chromeProcess.unref();
    console.log(`✅ [${gapId}] boot — Chrome spawned (pid: ${chromeProcess.pid}). Waiting for browser to load...`);
    await delay(7000); // Give Chrome time to fully open and render the extension page
  } catch (err: any) {
    console.error(`❌ [${gapId}] boot — Failed to spawn Chrome:`, err.message);
    return { success: false, output: `Boot failed: could not spawn Chrome. Error: ${err.message}` };
  }

  // ── Step B: Type the context block into the search bar via CDP ──
  if (contextBlock) {
    console.log(`📝 [${gapId}] boot — Typing query via CDP: "${contextBlock.substring(0, 80)}..."`);
    const cdpResult = await typeQueryViaCDP(gapId, contextBlock);
    if (!cdpResult.success) {
      return { success: false, output: `Boot failed: CDP could not type query. Error: ${cdpResult.error}` };
    }
    console.log(`✅ [${gapId}] boot — Query submitted via CDP. Panels are now generating responses.`);
  }

  return { success: true, output: 'Boot + query submission completed via CDP.\n=== END OF STEP 0 ===' };
}

/**
 * Execute a single panel session.
 */
async function executePanel(
  gapId: string,
  step: string,
  session: number,
  panelId: number,
  prompt: string,
  sessionKey: string,
  contextBlock?: string
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

      // Abort early if the workflow was stopped
      if (!activeWorkflows.has(gapId)) {
        return { success: false, output: '', error: 'Workflow was stopped' };
      }

      let output = '';

      if (step === 'step0') {
        // Step 0: run the full boot sequence (open Chrome + type query via CDP)
        const boot = await runBootSequence(gapId, sessionKey, 3, contextBlock);
        output = boot.output;
        if (boot.success) {
          output += '\n=== END OF STEP 0 ===';
        }
      } else if (step === 'step1a') {
        // Step 1: Wait for panels to generate, then read responses via CDP
        console.log(`⏳ [${gapId}] step1a — Waiting ${(config.panelWaitTimeMs + 3000) / 1000}s for panels to generate...`);
        await delay(config.panelWaitTimeMs + 5000);

        console.log(`📖 [${gapId}] step1a — Reading panel responses via CDP...`);
        const panelResult = await readPanelResponsesViaCDP(gapId);
        if (panelResult.success) {
          output = panelResult.formatted + '\n\n=== END OF STEP 1A ===';
        } else {
          output = 'Failed to read panel responses via CDP.';
        }
      } else if (step === 'step4a') {
        // Step 4: Type gap research query via CDP, wait, then read responses
        // The gap query is built from step2a context + step3 gap list
        // contextBlock here contains the gap research query built in runStep
        if (contextBlock) {
          console.log(`📝 [${gapId}] step4a — Typing gap research query via CDP...`);
          const cdpResult = await typeQueryViaCDP(gapId, contextBlock);
          if (!cdpResult.success) {
            output = `Failed to type gap query via CDP: ${cdpResult.error}`;
          } else {
            console.log(`⏳ [${gapId}] step4a — Waiting ${(config.panelWaitTimeMs + 3000) / 1000}s for panels to generate...`);
            await delay(config.panelWaitTimeMs + 5000);

            console.log(`📖 [${gapId}] step4a — Reading panel responses via CDP...`);
            const panelResult = await readPanelResponsesViaCDP(gapId);
            if (panelResult.success) {
              output = panelResult.formatted + '\n\n=== END OF STEP 4A ===';
            } else {
              output = 'Failed to read panel responses via CDP.';
            }
          }
        } else {
          output = 'No gap research query provided for step4a.';
        }
      } else {
        // All other steps: send prompt to MoltBot via WebSocket
        output = await wsClient.sendToSession(sessionKey, prompt, timeoutMs);
      }

      // For CDP-handled steps (step1a, step4a) and some analysis steps (step5a),
      // skip strict marker validation.
      const cdpHandledSteps = ['step1a', 'step4a'];
      const skipMarkerSteps = ['step5a', ...cdpHandledSteps];
      const requiresMarker = !skipMarkerSteps.includes(step);
      const passed = requiresMarker ? validateMarker(output, step) : true;

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

      if (!passed && requiresMarker) {
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

  // Abort if workflow was stopped externally
  if (!activeWorkflows.has(gapId)) {
    console.log(`⛔ [${gapId}] ${step} — workflow stopped, skipping step.`);
    return;
  }

  // Enforce step locking
  const check = canRunStep(workflow, step);
  if (!check.allowed) {
    throw new Error(check.reason!);
  }

  // Each workflow uses its own dedicated OpenClaw session key for true parallelism.
  const sessionKey = workflow.sessionKey || 'agent:main:main';
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

    // Inject downstream outputs
    // Step 1a and 4a are CDP-handled (no MoltBot prompt needed, but we still build context)
    if (step === 'step1b') {
      // CLEAN raw panel DOM from Step 1a
      const step1aOut = await StepOutput.findOne({ gapId, step: 'step1a', validationPassed: true });
      prompt = prompt.replace('{{RAW_PANEL_RESPONSES}}', step1aOut?.output || 'No raw panel responses available.');
    } else if (step === 'step2a') {
      // ANALYZE cleaned responses from Step 1b
      const step1bOut = await StepOutput.findOne({ gapId, step: 'step1b', validationPassed: true });
      prompt = prompt.replace('{{PANEL_RESPONSES}}', step1bOut?.output || 'No cleaned panel responses available.');
    } else if (step === 'step2b') {
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
    } else if (step === 'step4a') {
      // Build the gap research query that CDP will type into Simple Chat Hub
      const step2aOut = await StepOutput.findOne({ gapId, step: 'step2a', validationPassed: true });
      const step3Out = await StepOutput.findOne({ gapId, step: 'step3', validationPassed: true });
      const step3Text = step3Out?.output || '';
      const gapMatch = step3Text.match(/(?:Gap List|gap list|Gaps?|Remaining).*?\n([\s\S]*?)(?:===|$)/i);
      const gapList = gapMatch ? gapMatch[1].trim() : step3Text;
      // Build a query string that will be typed into Simple Chat Hub search bar
      const gapQuery = `Based on this research context:\n${(step2aOut?.output || 'No analysis context').substring(0, 2000)}\n\nPlease investigate and fill these identified gaps:\n${gapList}`;
      // Store the gap query as the contextBlock so executePanel can use it for CDP typing
      // We override workflow.contextBlock temporarily for this step
      (workflow as any)._step4GapQuery = gapQuery;
    } else if (step === 'step4b') {
      // CLEAN raw gap panel DOM from Step 4a
      const step4aOut = await StepOutput.findOne({ gapId, step: 'step4a', validationPassed: true });
      prompt = prompt.replace('{{RAW_GAP_PANEL_RESPONSES}}', step4aOut?.output || 'No raw gap panel responses available.');
    } else if (step === 'step5a') {
      // ANALYZE cleaned gap responses from Step 4b
      const step4bOut = await StepOutput.findOne({ gapId, step: 'step4b', validationPassed: true });
      prompt = prompt.replace('{{PANEL_RESPONSES}}', step4bOut?.output || 'No cleaned gap panel responses available.');
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

    // For step4a, pass the gap query as the contextBlock for CDP typing
    const contextBlockForStep = step === 'step4a' 
      ? (workflow as any)._step4GapQuery || workflow.contextBlock 
      : workflow.contextBlock;

    // Launch sessions in parallel
    const results = await Promise.all(
      Array.from({ length: totalSessions }, (_, i) => i + 1).map(
        (sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt, sessionKey, contextBlockForStep)
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
        } else if (step === 'step1a') {
          setImmediate(() => {
            runStep(gapId, 'step1b').catch(e => console.error(`Auto-chain 1b failed:`, e.message));
          });
        } else if (step === 'step1b') {
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
            runStep(gapId, 'step4a').catch(e => console.error(`Auto-chain 4a failed:`, e.message));
          });
        } else if (step === 'step4a') {
          setImmediate(() => {
            runStep(gapId, 'step4b').catch(e => console.error(`Auto-chain 4b failed:`, e.message));
          });
        } else if (step === 'step4b') {
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
           await closeBrowser(gapId);
           
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
    await closeBrowser(gapId);

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

    // Re-run failed sessions (using this workflow's dedicated session key)
    const sessionKey = workflow.sessionKey || 'agent:main:main';
    const results = await Promise.all(
      failedIds.map((sessionId) => executePanel(gapId, step, sessionId, sessionId, prompt, sessionKey))
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

  // Each workflow gets its own OpenClaw session key → true parallelism.
  const sessionKey = `agent:workflow:${gapId}`;

  // Snapshot current prompts
  const snapshot = { ...promptPlaceholders };

  const workflow = await Workflow.create({
    gapId,
    sessionKey,
    status: 'running',
    currentStep: 'step0',
    contextBlock,
    promptSnapshot: snapshot,
  });

  // Register as active
  activeWorkflows.set(gapId, sessionKey);
  console.log(`🚀 [${gapId}] Workflow started (session: ${sessionKey})`);

  emit({
    type: 'status_change',
    gapId,
    data: { status: 'running', currentStep: 'step0' },
  });

  // Run Step 0 (boot) in background, then Step 1a
  setImmediate(() => {
    runStep(gapId, 'step0')
      .then(() => {
        console.log(`⏳ [${gapId}] Waiting ${config.stepTransitionDelayMs / 1000}s for browser control service to stabilize...`);
        return delay(config.stepTransitionDelayMs);
      })
      .then(() => runStep(gapId, 'step1a'))
      .catch((err) => {
        console.error(`❌ [${gapId}] Boot/Step error:`, err.message);
      });
  });

  return workflow;
}

/**
 * Stop a running workflow immediately.
 * Removes it from the active map (causing executePanel / runStep to bail out)
 * and marks it as failed in MongoDB.
 */
export async function stopWorkflow(gapId: string): Promise<void> {
  const isActive = activeWorkflows.has(gapId);
  // Remove from active map first so any in-progress step bails on its next check
  activeWorkflows.delete(gapId);

  if (!isActive) {
    // Might already be stopped/completed — just ensure DB is consistent
    const wf = await Workflow.findOne({ gapId });
    if (!wf) throw new Error(`Workflow ${gapId} not found`);
    if (wf.status !== 'running') throw new Error(`Workflow ${gapId} is not running (status: ${wf.status})`);
  }

  await Workflow.updateOne(
    { gapId },
    { status: 'failed', failureReason: 'Stopped by user' }
  );
  await closeBrowser(gapId);

  emit({
    type: 'workflow_failed',
    gapId,
    data: { reason: 'Stopped by user', message: 'Workflow was manually stopped.' },
  });

  console.log(`⛔ [${gapId}] Workflow stopped by user.`);
}

/**
 * Delete a workflow and all its step outputs from MongoDB.
 * Stops it first if it is still running.
 */
export async function deleteWorkflow(gapId: string): Promise<void> {
  // Stop first if running
  if (activeWorkflows.has(gapId)) {
    activeWorkflows.delete(gapId);
    console.log(`⛔ [${gapId}] Stopped before deletion.`);
  }

  const deleted = await Workflow.deleteOne({ gapId });
  if (deleted.deletedCount === 0) throw new Error(`Workflow ${gapId} not found`);
  await StepOutput.deleteMany({ gapId });

  console.log(`🗑️ [${gapId}] Workflow deleted.`);
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
