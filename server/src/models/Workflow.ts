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
  step1:  { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 6 },
  step2a: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 3 },
  step2b: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step2c: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step3:  { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
};

const WorkflowSchema = new Schema<IWorkflow>(
  {
    gapId: { type: String, required: true, unique: true, index: true },
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
  { key: 'step1',  label: 'Step 1 — SEARCH',        parallelCount: 6, description: '6 parallel sessions' },
  { key: 'step2a', label: 'Step 2a — ANALYZE',       parallelCount: 3, description: '3 parallel sessions' },
  { key: 'step2b', label: 'Step 2b — CROSS-REVIEW',  parallelCount: 1, description: 'Single session' },
  { key: 'step2c', label: 'Step 2c — SYNTHESIZE',    parallelCount: 1, description: 'Single session' },
  { key: 'step3',  label: 'Step 3 — FINALIZE',       parallelCount: 1, description: 'Single session' },
];

// Step dependency chain: a step requires all its prerequisites to be 'completed'
export const STEP_PREREQUISITES: Record<string, string[]> = {
  step1:  [],
  step2a: ['step1'],
  step2b: ['step1'],
  step2c: ['step2a', 'step2b'],
  step3:  ['step2c'],
};
