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
} as const;

// Prompt placeholders — empty by default, editable from frontend
export const promptPlaceholders: PromptPlaceholders = {
  default_prompt_boot: '',
  default_prompt_step1: '',
  default_prompt_step2a: '',
  default_prompt_step2b: '',
  default_prompt_step2c: '',
  default_prompt_step3: '',
};

export function updatePromptPlaceholder(key: string, value: string): void {
  promptPlaceholders[key] = value;
}
