import { Schema, model, Document } from 'mongoose';

export interface IStepOutput extends Document {
  gapId: string;
  step: string;
  session: number;
  panel: number;
  output: string;
  validationPassed: boolean;
  storedInCoda: boolean;
  createdAt: Date;
}

const StepOutputSchema = new Schema<IStepOutput>(
  {
    gapId: { type: String, required: true, index: true },
    step: { type: String, required: true },
    session: { type: Number, required: true },
    panel: { type: Number, required: true },
    output: { type: String, default: '' },
    validationPassed: { type: Boolean, default: false },
    storedInCoda: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Compound index for efficient queries
StepOutputSchema.index({ gapId: 1, step: 1, session: 1 });

export const StepOutput = model<IStepOutput>('StepOutput', StepOutputSchema);
