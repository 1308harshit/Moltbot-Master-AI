import { WebSocketServer, WebSocket } from 'ws';
import { workflowEvents } from './workflowEngine';

const WS_PORT = 3002;
let wss: WebSocketServer | null = null;

export interface FrontendEvent {
  type: 'workflow:update' | 'step:update' | 'session:update' | 'notification';
  gapId: string;
  data: Record<string, unknown>;
}

/**
 * Start the WebSocket server for frontend clients.
 * Relays workflow events to all connected browsers.
 */
export function startWSServer(): void {
  wss = new WebSocketServer({ port: WS_PORT });

  console.log(`🔌 Frontend WebSocket server on ws://localhost:${WS_PORT}`);

  wss.on('connection', (ws: WebSocket) => {
    console.log('🔌 Frontend client connected');

    ws.on('close', () => {
      console.log('🔌 Frontend client disconnected');
    });

    ws.on('error', (err) => {
      console.error('🔌 Frontend WS error:', err.message);
    });
  });

  // Relay workflow engine events → all connected frontend clients
  workflowEvents.on('workflow_event', (event) => {
    const feEvent = mapEngineEvent(event);
    if (feEvent) {
      broadcast(feEvent);
    }
  });
}

/**
 * Map internal engine events to frontend WebSocket events.
 */
function mapEngineEvent(event: { type: string; gapId: string; data: Record<string, unknown> }): FrontendEvent | null {
  switch (event.type) {
    case 'status_change':
      return { type: 'workflow:update', gapId: event.gapId, data: event.data };

    case 'step_status_change':
      return { type: 'step:update', gapId: event.gapId, data: event.data };

    case 'panel_complete':
      return { type: 'session:update', gapId: event.gapId, data: event.data };

    case 'workflow_failed':
      // Send both a workflow update and a notification
      broadcast({
        type: 'notification',
        gapId: event.gapId,
        data: {
          level: 'error',
          title: 'Workflow Failed',
          message: event.data.message as string,
          step: event.data.step,
          failedSession: event.data.failedSession,
        },
      });
      return { type: 'workflow:update', gapId: event.gapId, data: { status: 'failed', ...event.data } };

    case 'workflow_completed':
      broadcast({
        type: 'notification',
        gapId: event.gapId,
        data: {
          level: 'success',
          title: 'Workflow Completed',
          message: 'All sessions passed successfully.',
        },
      });
      return { type: 'workflow:update', gapId: event.gapId, data: { status: 'completed', ...event.data } };

    default:
      return { type: 'workflow:update', gapId: event.gapId, data: event.data };
  }
}

/**
 * Broadcast a message to all connected frontend clients.
 */
export function broadcast(event: FrontendEvent): void {
  if (!wss) return;

  const payload = JSON.stringify(event);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
