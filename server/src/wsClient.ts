import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WSMessage {
  type: string;
  nodeId: string;
  payload: {
    message: string;
  };
  requestId?: string;
}

interface WSResponse {
  type: string;
  requestId?: string;
  payload?: {
    message?: string;
    content?: string;
    error?: string;
  };
  error?: string;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private isConnected = false;
  private url: string;
  private connectPromise: Promise<void> | null = null;

  constructor(url?: string) {
    this.url = url || config.wsUrl;
  }

  /**
   * Connect to the WebSocket server.
   * Returns a promise that resolves when connected.
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          console.log(`🔌 WebSocket connected to ${this.url}`);
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.connectPromise = null;
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`🔌 WebSocket closed: ${code} — ${reason.toString()}`);
          this.isConnected = false;
          this.connectPromise = null;
          this.rejectAllPending(new Error(`WebSocket closed: ${code}`));
          this.attemptReconnect();
        });

        this.ws.on('error', (err: Error) => {
          console.error('🔌 WebSocket error:', err.message);
          this.isConnected = false;
          this.connectPromise = null;
          reject(err);
        });
      } catch (err) {
        this.connectPromise = null;
        reject(err);
      }
    });

    return this.connectPromise;
  }

  /**
   * Send a prompt to a specific panel and wait for the response.
   * Returns the response string via promise-based tracking.
   */
  async sendToPanel(panelId: number, prompt: string, timeoutMs = 120000): Promise<string> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const requestId = uuidv4();
    const nodeId = `simplechathub.panel.${panelId}`;

    const message: WSMessage = {
      type: 'node.invoke',
      nodeId,
      payload: {
        message: prompt,
      },
      requestId,
    };

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout waiting for response from panel ${panelId} (requestId: ${requestId})`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          reject(new Error(`Failed to send message to panel ${panelId}: ${err.message}`));
        }
      });

      console.log(`📤 Sent to ${nodeId} [${requestId}]: ${prompt.substring(0, 80)}...`);
    });
  }

  /**
   * Handle incoming WebSocket messages.
   * Matches responses to pending requests by requestId.
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const response: WSResponse = JSON.parse(data.toString());

      // Match by requestId
      if (response.requestId && this.pendingRequests.has(response.requestId)) {
        const pending = this.pendingRequests.get(response.requestId)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.requestId);

        if (response.error || response.payload?.error) {
          pending.reject(new Error(response.error || response.payload?.error || 'Unknown WS error'));
        } else {
          const content = response.payload?.message || response.payload?.content || JSON.stringify(response.payload);
          pending.resolve(content);
        }

        console.log(`📥 Response for [${response.requestId}]: ${(response.payload?.message || '').substring(0, 80)}...`);
      } else {
        // Unmatched message — log it
        console.log(`📥 Unmatched WS message:`, JSON.stringify(response).substring(0, 200));
      }
    } catch (err) {
      console.error('Failed to parse WS message:', err);
    }
  }

  /**
   * Attempt reconnection with exponential backoff.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('🔌 Max reconnect attempts reached. Giving up.');
      return;
    }

    const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`🔌 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        console.error('🔌 Reconnect failed:', (err as Error).message);
      }
    }, delay);
  }

  /**
   * Reject all pending requests (called on disconnect).
   */
  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.rejectAllPending(new Error('Client disconnected'));
  }

  /**
   * Check if the client is currently connected.
   */
  get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const wsClient = new WSClient();
