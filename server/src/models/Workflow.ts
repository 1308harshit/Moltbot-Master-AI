import { Schema, model, Document } from 'mongoose';

export type WorkflowStatus = 'running' | 'failed' | 'completed';
export type StepStatusType = 'idle' | 'running' | 'completed' | 'failed';

export interface IStepStatus {
  status: StepStatusType;
  completedSessions: number;
  failedSessions: number[];
  totalSessions: number;
  failureReason?: string;
}

export interface IWorkflow extends Document {
  gapId: string;
  sessionKey: string;
  status: WorkflowStatus;
  currentStep: string;
  contextBlock: string;
  failureReason?: string;
  failedSession?: number;
  stepStatuses: Record<string, IStepStatus>;
  promptSnapshot: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

const StepStatusSchema = new Schema<IStepStatus>(
  {
    status: { type: String, enum: ['idle', 'running', 'completed', 'failed'], default: 'idle' },
    completedSessions: { type: Number, default: 0 },
    failedSessions: [{ type: Number }],
    totalSessions: { type: Number, default: 6 },
    failureReason: { type: String },
  },
  { _id: false }
);

const DEFAULT_STEP_STATUSES: Record<string, IStepStatus> = {
  step0:  { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step1a: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step1b: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step2a: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step2b: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step2c: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step3:  { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step4a: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step4b: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step5a: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step5b: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step5c: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step6:  { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
};

const WorkflowSchema = new Schema<IWorkflow>(
  {
    gapId: { type: String, required: true, unique: true, index: true },
    sessionKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['running', 'failed', 'completed'],
      default: 'running',
    },
    currentStep: { type: String, default: 'step0' },
    contextBlock: { type: String, required: true },
    failureReason: { type: String },
    failedSession: { type: Number },
    stepStatuses: {
      type: Map,
      of: StepStatusSchema,
      default: () => new Map(Object.entries(DEFAULT_STEP_STATUSES)),
    },
    promptSnapshot: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
  },
  {
    timestamps: true,
  }
);

export const Workflow = model<IWorkflow>('Workflow', WorkflowSchema);

export const STEP_DEFINITIONS = [
  // Round 1: Initial Research
  { key: 'step0',  label: 'Step 0 — BOOT',              parallelCount: 1, description: 'Environment boot / browser prep' },
  { key: 'step1a', label: 'Step 1a — SEARCH',           parallelCount: 1, description: 'Single session via Master Search Bar (raw DOM)' },
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

// Step dependency chain: a step requires all its prerequisites to be 'completed'
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
