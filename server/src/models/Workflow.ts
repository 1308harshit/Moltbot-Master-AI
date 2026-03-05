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
  // step0: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 }, // BOOT — disabled
  step1: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  // step2: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 }, // EVALUATE — disabled
  step3: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step4: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step5: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  // step6: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 }, // EVALUATE GAPS — disabled
  step7: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step8: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
  step9: { status: 'idle', completedSessions: 0, failedSessions: [], totalSessions: 1 },
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
    currentStep: { type: String, default: 'step1' },
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
  // { key: 'step0', label: 'Step 0 — BOOT', parallelCount: 1, description: 'Open browser + 6 AI tabs' }, // BOOT — disabled
  { key: 'step1', label: 'Step 1 — QUERY',          parallelCount: 1, description: 'Query all 6 tabs + fetch responses' },
  // { key: 'step2', label: 'Step 2 — EVALUATE',    parallelCount: 1, description: 'Cross-review the 6 responses' }, // EVALUATE — disabled
  { key: 'step3', label: 'Step 3 — VOTE',           parallelCount: 1, description: 'Quality scoring (8 criteria)' },
  { key: 'step4', label: 'Step 4 — FINALIZE (R1)',  parallelCount: 1, description: 'Consolidate findings + gap list' },
  { key: 'step5', label: 'Step 5 — GAP QUERY',      parallelCount: 1, description: 'Query gap topics in all 6 tabs' },
  // { key: 'step6', label: 'Step 6 — EVALUATE (Gaps)', parallelCount: 1, description: 'Cross-review gap responses' }, // EVALUATE GAPS — disabled
  { key: 'step7', label: 'Step 7 — VOTE (Gaps)',    parallelCount: 1, description: 'Quality scoring of gap research' },
  { key: 'step8', label: 'Step 8 — FINAL REPORT',   parallelCount: 1, description: 'Merge R1 + gaps into final document' },
  { key: 'step9', label: 'Step 9 — CLOSE',          parallelCount: 1, description: 'Close the browser' },
];

// Step dependency chain (step2 and step6 are skipped)
export const STEP_PREREQUISITES: Record<string, string[]> = {
  // step0: [], // BOOT — disabled
  step1: [],           // No prereqs — workflow starts here
  // step2: ['step1'], // EVALUATE — disabled
  step3: ['step1'],    // VOTE gets Step 1 output directly (no eval step)
  step4: ['step3'],
  step5: ['step4'],
  // step6: ['step5'], // EVALUATE GAPS — disabled
  step7: ['step5'],    // VOTE GAPS gets Step 5 output directly (no eval step)
  step8: ['step7'],
  step9: ['step8'],
};
