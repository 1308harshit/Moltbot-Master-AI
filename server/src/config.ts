import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface PromptPlaceholders {
  default_prompt_boot: string;
  default_prompt_step1: string;
  default_prompt_step2a: string;
  default_prompt_step2b: string;
  default_prompt_step2c: string;
  default_prompt_step3: string;
  default_prompt_step4: string;
  default_prompt_step5a: string;
  default_prompt_step5b: string;
  default_prompt_step5c: string;
  default_prompt_step6: string;
  [key: string]: string;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/moltbot-orchestration',
  codaApiKey: process.env.CODA_API_KEY || '',
  codaDocId: process.env.CODA_DOC_ID || '',
  codaTableId: process.env.CODA_TABLE_ID || '',
  wsUrl: process.env.WS_URL || 'ws://127.0.0.1:18789/',
  panelCount: 6,
  validationMarkers: {
    step1: '=== END OF STEP 1 ===',
  },

  // Resilience settings for browser-dependent steps
  stepTransitionDelayMs: parseInt(process.env.STEP_TRANSITION_DELAY_MS || '5000', 10),      // delay between steps
  panelRetryCount: parseInt(process.env.PANEL_RETRY_COUNT || '2', 10),                      // max retries on transient failure
  panelRetryDelayMs: parseInt(process.env.PANEL_RETRY_DELAY_MS || '10000', 10),             // delay between retries
  browserStepTimeoutMs: parseInt(process.env.BROWSER_STEP_TIMEOUT_MS || '600000', 10),      // timeout for browser-dependent steps (default 10 minutes)
} as const;

// Prompt placeholders — opinionated defaults, editable from frontend
// These are simple, direct MoltBot commands — not elaborate structured instructions.
export const promptPlaceholders: PromptPlaceholders = {
  default_prompt_boot: `end with 
=== END OF STEP 0 ===`,

  default_prompt_step1: `In the Simple Chat Hub browser extension UI that is already open, click on the search bar at the top (the input that says "Press Enter to send"), type the following text and press Enter:

 "{{CONTEXT_BLOCK}}"

Wait until as many AI panels as possible have fully finished generating their responses.
- If a panel (for example Claude or Qwen Chat) is stuck on "Loading", "Claude will return soon", shows an error, or never completes, IGNORE that panel and do not wait for it.
- Do not try to fix, refresh, or retry stuck panels.
- Do not open any new tabs or windows.

Regardless of how many panels responded, you MUST end your response with exactly:
=== END OF STEP 1 ===`,

  default_prompt_step2a: `in simple chat hub extension ui, read the full response text from each of the 6 panels (ChatGPT, Gemini, Grok, Claude, Perplexity, Qwen Chat).

For each panel, output the panel name followed by its full response.

Then analyze all 6 responses and produce:
1. Common Themes
2. Major Differences
3. Strengths and Weaknesses
4. Missing Areas
5. Preliminary Conclusion

End your response with:
=== END OF STEP 2A ===`,

  default_prompt_step2b: `Based on the analysis below, perform a cross-review and produce a final consolidated analysis.

INPUT:
{{STEP2A_OUTPUTS}}

You must:
- Compare the findings
- Resolve contradictions
- Strengthen weak areas
- Produce a refined synthesis

OUTPUT:
1. Comparative Summary
2. Resolved Conflicts
3. Final Consolidated Analysis

End your response with:
=== END OF STEP 2B ===`,

  default_prompt_step2c: `Based on the consolidated analysis below, perform a final quality evaluation.

INPUT:
{{STEP2B_OUTPUTS}}

Score the analysis on 8 criteria (1-5 each) to ensure it meets high research standards.

OUTPUT:
1. Score Table
2. Total Quality Score
3. Evaluation Summary

End your response with:
=== END OF STEP 2C ===`,

  default_prompt_step3: `Produce the first-round consolidated research document.

Analysis Input:
{{ANALYSIS_INPUT}}

Quality Evaluation:
{{QUALITY_EVALUATION}}

OUTPUT:
1. Final Executive Summary
2. Detailed Findings
3. Integrated Insights
4. Final Recommendations
5. Gap List (bullet points of missing information, uncited claims, or areas needing deeper research)

End your response with:
=== END OF STEP 3 ===`,

  // ─── Round 2: Gap Research ───

  default_prompt_step4: `In the Simple Chat Hub browser extension UI that is already open, click on the search bar at the top (the input that says "Press Enter to send"), type the following text and press Enter:

 "Based on this research context:
{{STEP2A_CONTEXT}}

Please investigate and fill these identified gaps:
{{GAP_LIST}}"

Wait until as many AI panels as possible have fully finished generating their responses.
- If a panel (for example Claude or Qwen Chat) is stuck on "Loading", "Claude will return soon", shows an error, or never completes, IGNORE that panel and do not wait for it.
- Do not try to fix, refresh, or retry stuck panels.
- Do not open any new tabs or windows.

Regardless of how many panels responded, you MUST end your response with exactly:
=== END OF STEP 4 ===`,

  default_prompt_step5a: `in simple chat hub extension ui, read the full response text from each of the 6 panels (ChatGPT, Gemini, Grok, Claude, Perplexity, Qwen Chat).

For each panel, output the panel name followed by its full response.

Then analyze all 6 responses and produce:
1. Common Themes
2. Major Differences
3. Strengths and Weaknesses
4. Missing Areas
5. Preliminary Conclusion

End your response with:
=== END OF STEP 5A ===`,

  default_prompt_step5b: `Based on the gap analysis below, perform a cross-review and produce a final consolidated gap analysis.

Original Research (Round 1):
{{ROUND1_OUTPUT}}

New Gap Research:
{{STEP5A_OUTPUTS}}

You must:
- Compare the new gap findings with the original research
- Resolve contradictions
- Fill in the gaps that were identified
- Produce a refined synthesis that strengthens the original research

OUTPUT:
1. Comparative Summary
2. Resolved Gaps
3. Final Consolidated Gap Analysis

End your response with:
=== END OF STEP 5B ===`,

  default_prompt_step5c: `Based on the consolidated gap analysis below, perform a final quality evaluation.

INPUT:
{{STEP5B_OUTPUTS}}

Score the analysis on 8 criteria (1-5 each) to ensure it meets high research standards.

OUTPUT:
1. Score Table
2. Total Quality Score
3. Evaluation Summary

End your response with:
=== END OF STEP 5C ===`,

  default_prompt_step6: `Produce the final, complete research document by merging the original research with the gap research.

Original Research (Round 1):
{{ROUND1_OUTPUT}}

Gap Analysis:
{{GAP_ANALYSIS_INPUT}}

Gap Quality Evaluation:
{{GAP_QUALITY_EVALUATION}}

OUTPUT:
1. Final Executive Summary
2. Comprehensive Findings (original + gap research merged)
3. Integrated Insights
4. Final Recommendations
5. Remaining Limitations (if any)

End your response with:
=== END OF STEP 6 ===`,
};

export function updatePromptPlaceholder(key: string, value: string): void {
  promptPlaceholders[key] = value;
}
