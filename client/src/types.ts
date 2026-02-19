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
  { key: 'step1',  label: 'Step 1 — SEARCH',       parallelCount: 6, description: '6 parallel sessions' },
  { key: 'step2a', label: 'Step 2a — ANALYZE',      parallelCount: 3, description: '3 parallel sessions' },
  { key: 'step2b', label: 'Step 2b — CROSS-REVIEW', parallelCount: 1, description: 'Single session' },
  { key: 'step2c', label: 'Step 2c — SYNTHESIZE',   parallelCount: 1, description: 'Single session' },
  { key: 'step3',  label: 'Step 3 — FINALIZE',      parallelCount: 1, description: 'Single session' },
];

export const STEP_PREREQUISITES: Record<string, string[]> = {
  step1:  [],
  step2a: ['step1'],
  step2b: ['step1'],
  step2c: ['step2a', 'step2b'],
  step3:  ['step2c'],
};

export const API_BASE = 'http://localhost:3001';
export const WS_URL = 'ws://localhost:3002';
