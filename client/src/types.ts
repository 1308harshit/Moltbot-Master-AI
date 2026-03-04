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
  // { key: 'step0', label: 'Step 0 — BOOT',             parallelCount: 1, description: 'Open browser + 6 AI tabs' }, // BOOT — disabled
  { key: 'step1', label: 'Step 1 — QUERY',            parallelCount: 1, description: 'Query all 6 tabs + fetch responses' },
  { key: 'step2', label: 'Step 2 — EVALUATE',         parallelCount: 1, description: 'Cross-review the 6 responses' },
  { key: 'step3', label: 'Step 3 — VOTE',             parallelCount: 1, description: 'Quality scoring (8 criteria)' },
  { key: 'step4', label: 'Step 4 — FINALIZE (R1)',    parallelCount: 1, description: 'Consolidate findings + gap list' },
  // Round 2: Gap Research
  { key: 'step5', label: 'Step 5 — GAP QUERY',        parallelCount: 1, description: 'Query gap topics in all 6 tabs' },
  { key: 'step6', label: 'Step 6 — EVALUATE (Gaps)',   parallelCount: 1, description: 'Cross-review gap responses' },
  { key: 'step7', label: 'Step 7 — VOTE (Gaps)',      parallelCount: 1, description: 'Quality scoring of gap research' },
  { key: 'step8', label: 'Step 8 — FINAL REPORT',     parallelCount: 1, description: 'Merge R1 + gaps into final document' },
  // Cleanup
  { key: 'step9', label: 'Step 9 — CLOSE',            parallelCount: 1, description: 'Close the browser' },
];

export const STEP_PREREQUISITES: Record<string, string[]> = {
  // step0: [], // BOOT — disabled
  step1: [],           // No prereqs — workflow starts here
  step2: ['step1'],
  step3: ['step2'],
  step4: ['step3'],
  step5: ['step4'],
  step6: ['step5'],
  step7: ['step6'],
  step8: ['step7'],
  step9: ['step8'],
};

export const API_BASE = 'http://localhost:3001';
export const WS_URL = 'ws://localhost:3002';
