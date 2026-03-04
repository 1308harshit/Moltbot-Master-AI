import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface PromptPlaceholders {
  default_prompt_boot: string;
  default_prompt_step1: string;
  default_prompt_step2: string;
  default_prompt_step3: string;
  default_prompt_step4: string;
  default_prompt_step5: string;
  default_prompt_step6: string;
  default_prompt_step7: string;
  default_prompt_step8: string;
  default_prompt_step9: string;
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
    step1: 'END OF RESPONSE A',
  },

  // Resilience settings for browser-dependent steps
  stepTransitionDelayMs: parseInt(process.env.STEP_TRANSITION_DELAY_MS || '5000', 10),
  panelRetryCount: parseInt(process.env.PANEL_RETRY_COUNT || '2', 10),
  panelRetryDelayMs: parseInt(process.env.PANEL_RETRY_DELAY_MS || '10000', 10),
  browserStepTimeoutMs: parseInt(process.env.BROWSER_STEP_TIMEOUT_MS || '600000', 10),
} as const;

// ═══════════════════════════════════════════
// Prompt Templates — 6-Tab Direct Architecture
// ═══════════════════════════════════════════
export const promptPlaceholders: PromptPlaceholders = {

  // ─── Step 0: BOOT — DISABLED (workflow starts directly at Step 1) ───
  // Kept for future use:
  // default_prompt_boot: `open browser,
  // in that open
  // tab1: https://chatgpt.com/
  // tab2: https://gemini.google.com/app
  // tab3: https://grok.com/
  // tab4: https://claude.ai/new
  // tab5: https://www.perplexity.ai/
  // tab6: https://chat.qwen.ai/
  //
  // no need to do anything else, just open these 6 tabs.
  //
  // end with
  // === END OF STEP 0 ===`,
  default_prompt_boot: '', // placeholder — step0 is skipped

  // ─── Step 1: QUERY — Search in all 6 tabs + fetch responses ───
  default_prompt_step1: `open browser,
in that open
tab1: https://chatgpt.com/
tab2: https://gemini.google.com/app
tab3: https://grok.com/
tab4: https://claude.ai/new
tab5: https://www.perplexity.ai/
tab6: https://chat.qwen.ai/

and search for "{{CONTEXT_BLOCK}}" in all the tabs,
no need to open any extra tabs after opening this 6 tabs.

Wait for the response of the 6 tabs and fetch the exact response of 6 tabs

only give me the response in your answer in the format of
Tab1 - Chatgpt:
[RESPONSE OF TAB 1]

Tab2 - Gemini:
[RESPONSE OF TAB 2]

Tab3 - Grok:
[RESPONSE OF TAB 3]

Tab4 - Claude:
[RESPONSE OF TAB 4]

Tab5 - Perplexity:
[RESPONSE OF TAB 5]

Tab6 - Qwen:
[RESPONSE OF TAB 6]

and append the text "END OF RESPONSE A" at the last.`,

  // ─── Step 2: EVALUATE — Cross-review the 6 responses ───
  default_prompt_step2: `Based on the 6 AI responses below, perform a thorough cross-review.

INPUT (Raw Responses from 6 AI Tabs):
{{STEP1_OUTPUT}}

You must:
1. Compare all 6 responses side by side
2. Identify common themes across responses
3. Identify major differences and contradictions
4. Assess strengths and weaknesses of each response
5. Identify missing areas or gaps in coverage

OUTPUT:
1. Common Themes
2. Major Differences
3. Strengths and Weaknesses (per tab)
4. Missing Areas
5. Preliminary Conclusion

End your response with:
=== END OF STEP 2 ===`,

  // ─── Step 3: VOTE — Quality scoring on 8 criteria ───
  default_prompt_step3: `Based on the cross-review analysis below, perform a final quality evaluation and vote on the quality of the research.

INPUT:
{{STEP2_OUTPUT}}

Score the analysis on 8 criteria (1-5 each) to ensure it meets high research standards:
1. Comprehensiveness — Does it cover the topic fully?
2. Accuracy — Are the claims factually correct?
3. Depth — Does it go beyond surface-level analysis?
4. Recency — Does it reflect the latest information?
5. Source Quality — Are the sources reliable and diverse?
6. Objectivity — Is it balanced and unbiased?
7. Actionability — Are the insights practical and actionable?
8. Consistency — Do the findings agree across different AI responses?

OUTPUT:
1. Score Table (criterion | score | justification)
2. Total Quality Score (out of 40)
3. Evaluation Summary
4. Quality Verdict (PASS if score >= 28, NEEDS IMPROVEMENT otherwise)

End your response with:
=== END OF STEP 3 ===`,

  // ─── Step 4: FINALIZE R1 — Consolidate + gap list ───
  default_prompt_step4: `Produce the first-round consolidated research document.

Raw AI Responses:
{{STEP1_OUTPUT}}

Cross-Review:
{{STEP2_OUTPUT}}

Quality Evaluation:
{{STEP3_OUTPUT}}

OUTPUT:
1. Final Executive Summary
2. Detailed Findings (synthesized from all 6 AI responses)
3. Integrated Insights
4. Final Recommendations
5. Gap List (bullet points of missing information, uncited claims, or areas needing deeper research)

End your response with:
=== END OF STEP 4 ===`,

  // ─── Step 5: GAP QUERY — Search gaps in all 6 tabs ───
  default_prompt_step5: `the following tabs are already open,
tab1: https://chatgpt.com/
tab2: https://gemini.google.com/app
tab3: https://grok.com/
tab4: https://claude.ai/new
tab5: https://www.perplexity.ai/
tab6: https://chat.qwen.ai/

so in the same tabs search for "Based on this research context:
{{STEP1_CONTEXT}}

Please investigate and fill these identified gaps:
{{GAP_LIST}}" in all the tabs,
no need to open any extra tabs after opening this 6 tabs

Wait for the response of the 6 tabs and fetch the exact response of 6 tabs

only give me the response in your answer in the format of
Tab1 - Chatgpt:
[RESPONSE OF TAB 1]

Tab2 - Gemini:
[RESPONSE OF TAB 2]

Tab3 - Grok:
[RESPONSE OF TAB 3]

Tab4 - Claude:
[RESPONSE OF TAB 4]

Tab5 - Perplexity:
[RESPONSE OF TAB 5]

Tab6 - Qwen:
[RESPONSE OF TAB 6]

and append the text "END OF RESPONSE B" at the last.`,

  // ─── Step 6: EVALUATE GAPS — Cross-review gap responses ───
  default_prompt_step6: `Based on the gap research responses below, perform a cross-review, merging with the original Round 1 findings.

Original Research (Round 1):
{{ROUND1_OUTPUT}}

New Gap Research (Raw Responses from 6 AI Tabs):
{{STEP5_OUTPUT}}

You must:
1. Compare the new gap findings with the original research
2. Resolve contradictions between original and new findings
3. Fill in the gaps that were identified
4. Produce a refined synthesis that strengthens the original research

OUTPUT:
1. Comparative Summary
2. Resolved Gaps
3. Final Consolidated Gap Analysis

End your response with:
=== END OF STEP 6 ===`,

  // ─── Step 7: VOTE GAPS — Quality scoring of gap research ───
  default_prompt_step7: `Based on the consolidated gap analysis below, perform a final quality evaluation and vote on the quality of the gap research.

INPUT:
{{STEP6_OUTPUT}}

Score the analysis on 8 criteria (1-5 each) to ensure it meets high research standards:
1. Comprehensiveness — Does it fill the identified gaps?
2. Accuracy — Are the new claims factually correct?
3. Depth — Does it go beyond surface-level gap-filling?
4. Recency — Does it reflect the latest information?
5. Source Quality — Are the sources reliable and diverse?
6. Objectivity — Is it balanced and unbiased?
7. Actionability — Are the insights practical and actionable?
8. Consistency — Do the gap findings align with the original research?

OUTPUT:
1. Score Table (criterion | score | justification)
2. Total Quality Score (out of 40)
3. Evaluation Summary
4. Quality Verdict (PASS if score >= 28, NEEDS IMPROVEMENT otherwise)

End your response with:
=== END OF STEP 7 ===`,

  // ─── Step 8: FINAL REPORT — Merge everything ───
  default_prompt_step8: `Produce the final, complete research document by merging the original research with the gap research.

Original Research (Round 1):
{{ROUND1_OUTPUT}}

Gap Analysis:
{{GAP_ANALYSIS}}

Gap Quality Evaluation:
{{GAP_QUALITY}}

OUTPUT:
1. Final Executive Summary
2. Comprehensive Findings (original + gap research merged)
3. Integrated Insights
4. Final Recommendations
5. Remaining Limitations (if any)

End your response with:
=== END OF STEP 8 ===`,

  // ─── Step 9: CLOSE — Close the browser ───
  default_prompt_step9: `close browser

=== END OF STEP 9 ===`,
};

export function updatePromptPlaceholder(key: string, value: string): void {
  promptPlaceholders[key] = value;
}
