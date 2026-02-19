import { config } from './config';

interface CodaRow {
  gapId: string;
  step: string;
  session: number;
  outputSummary: string;
  status: string;
  timestamp: string;
}

/**
 * Push a validated row to the Coda "WorkflowRuns" table.
 * Only call this after validation passes.
 */
export async function pushToCoda(row: CodaRow): Promise<boolean> {
  const { codaApiKey, codaDocId, codaTableId } = config;

  if (!codaApiKey || !codaDocId || !codaTableId) {
    console.warn('⚠️  Coda credentials not configured. Skipping Coda push.');
    return false;
  }

  const url = `https://coda.io/apis/v1/docs/${codaDocId}/tables/${codaTableId}/rows`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${codaApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rows: [
          {
            cells: [
              { column: 'gapId', value: row.gapId },
              { column: 'step', value: row.step },
              { column: 'session', value: row.session },
              { column: 'outputSummary', value: row.outputSummary },
              { column: 'status', value: row.status },
              { column: 'timestamp', value: row.timestamp },
            ],
          },
        ],
        keyColumns: ['gapId', 'step', 'session'],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ Coda push failed (${response.status}):`, errorBody);
      return false;
    }

    console.log(`📊 Coda: pushed row for ${row.gapId} / ${row.step} / session ${row.session}`);
    return true;
  } catch (error) {
    console.error('❌ Coda push error:', error);
    return false;
  }
}
