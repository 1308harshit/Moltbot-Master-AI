// ═══════════════════════════════════════════
// Shared types for the MoltBot Orchestrator
// ═══════════════════════════════════════════

export type WorkflowStatusType = 'running' | 'failed' | 'completed';
export type StepStatusType = 'idle' | 'running' | 'completed' | 'failed';

export interface StepStatus {
  status: StepStatusType;
  completedSessions: number;
  failedSessions: number[];
  totalSessions: number;
  failureReason?: string;
}

export interface StepOutputData {
  step: string;
  session: number;
  panel: number;
  validationPassed: boolean;
  storedInCoda: boolean;
  output: string;
  createdAt: string;
}

export interface WorkflowData {
  gapId: string;
  status: WorkflowStatusType;
  currentStep: string;
  failureReason?: string;
  failedSession?: number;
  stepStatuses: Record<string, StepStatus>;
  stepOutputs: StepOutputData[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowHistoryItem {
  gapId: string;
  status: WorkflowStatusType;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  level: 'error' | 'success' | 'info' | 'warning';
  title: string;
  message: string;
  step?: string;
  failedSession?: number;
  timestamp: number;
  dismissed: boolean;
}

export interface WSEvent {
  type: 'workflow:update' | 'step:update' | 'session:update' | 'notification';
  gapId: string;
  data: Record<string, unknown>;
}

export const STEP_DEFINITIONS = [
  // Round 1: Initial Research
  { key: 'step0',  label: 'Step 0 — BOOT',              parallelCount: 1, description: 'Environment boot / browser prep' },
  { key: 'step1a', label: 'Step 1a — SEARCH',           parallelCount: 1, description: 'Search context in SimpleChatHub (raw DOM)' },
  { key: 'step1b', label: 'Step 1b — CLEAN',            parallelCount: 1, description: 'Clean DOM text into pure AI answers' },
  { key: 'step2a', label: 'Step 2a — ANALYZE',           parallelCount: 1, description: 'Read and analyze 6 panel responses' },
  { key: 'step2b', label: 'Step 2b — CROSS-REVIEW',      parallelCount: 1, description: 'Cross-review and consolidate' },
  { key: 'step2c', label: 'Step 2c — EVALUATE',          parallelCount: 1, description: 'Quality evaluation' },
  { key: 'step3',  label: 'Step 3 — FINALIZE (Round 1)', parallelCount: 1, description: 'First finalization with gap list' },
  // Round 2: Gap Research
  { key: 'step4a', label: 'Step 4a — SEARCH (Gaps)',     parallelCount: 1, description: 'Search gap topics in SimpleChatHub (raw DOM)' },
  { key: 'step4b', label: 'Step 4b — CLEAN (Gaps)',      parallelCount: 1, description: 'Clean gap DOM text into pure AI answers' },
  { key: 'step5a', label: 'Step 5a — ANALYZE (Gaps)',     parallelCount: 1, description: 'Read and analyze gap responses' },
  { key: 'step5b', label: 'Step 5b — CROSS-REVIEW (Gaps)',parallelCount: 1, description: 'Cross-review gap findings with Round 1' },
  { key: 'step5c', label: 'Step 5c — EVALUATE (Gaps)',    parallelCount: 1, description: 'Quality evaluation of gap research' },
  { key: 'step6',  label: 'Step 6 — FINALIZE (Final)',   parallelCount: 1, description: 'Final complete research document' },
];

export const STEP_PREREQUISITES: Record<string, string[]> = {
  step0:  [],
  step1a: ['step0'],
  step1b: ['step1a'],
  step2a: ['step1b'],
  step2b: ['step2a'],
  step2c: ['step2b'],
  step3:  ['step2c'],
  step4a: ['step3'],
  step4b: ['step4a'],
  step5a: ['step4b'],
  step5b: ['step5a'],
  step5c: ['step5b'],
  step6:  ['step5c'],
};

export const API_BASE = 'http://localhost:3001';
export const WS_URL = 'ws://localhost:3002';
