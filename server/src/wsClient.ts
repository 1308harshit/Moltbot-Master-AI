import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';

/**
 * EventEmitter for real-time streaming.
 * Emits 'chunk' events: { runId, sessionKey, text }
 * Emits 'final' events: { runId, sessionKey, text }
 */
export const streamEvents = new EventEmitter();

interface PendingRequest {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type GatewayEventFrame = {
  type: 'event';
  event: string;
  payload?: unknown;
};

type GatewayResponseFrame = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string } | undefined;
};

type GatewayRequestFrame = {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  return [
    'v2',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join('|');
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

function resolveIdentityPath(): string {
  // Persist identity so pairing/device tokens work across restarts.
  // On Windows this lands under %USERPROFILE%\.moltbot-orchestrator\openclaw-device.json
  return path.join(os.homedir(), '.moltbot-orchestrator', 'openclaw-device.json');
}

function loadOrCreateDeviceIdentity(filePath = resolveIdentityPath()): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DeviceIdentity> & { version?: number };
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        const identity = {
          deviceId: derivedId || parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
        if (derivedId && derivedId !== parsed.deviceId) {
          fs.writeFileSync(
            filePath,
            `${JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2)}\n`
          );
        }
        return identity;
      }
    }
  } catch {
    // regenerate below
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  const identity: DeviceIdentity = { deviceId, publicKeyPem, privateKeyPem };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2)}\n`);
  return identity;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pendingRuns: Map<
    string,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      latestText: string;
      sessionKey: string;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private isConnected = false; // connected + completed OpenClaw handshake
  private url: string;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectNonce: string | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private identity: DeviceIdentity;
  private token: string | undefined;

  constructor(url?: string) {
    this.url = url || config.wsUrl;
    this.identity = loadOrCreateDeviceIdentity();
    this.token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || process.env.WS_TOKEN || undefined;
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
        this.connectResolve = resolve;
        this.connectReject = reject;
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          console.log(`🔌 WebSocket connected to ${this.url} (awaiting OpenClaw handshake)`);
          this.isConnected = false;
          this.connectNonce = null;

          // OpenClaw gateway sends connect.challenge immediately; if we don't receive it, fail fast.
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = setTimeout(() => {
            if (this.isConnected) return;
            const err = new Error('gateway connect.challenge timeout');
            reject(err);
            this.ws?.close(1008, 'connect challenge timeout');
          }, 2000);
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
    const sessionKey = `panel-${panelId}`;
    return this.sendToSession(sessionKey, prompt, timeoutMs);
  }

  /**
   * Send a prompt to an arbitrary OpenClaw session key and wait for the response.
   * Useful for diagnostics and non-panel flows.
   */
  async sendToSession(sessionKey: string, prompt: string, timeoutMs = 120000): Promise<string> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    // chat.send is non-blocking in OpenClaw 2026.3.1+.
    // It resolves immediately with { runId, status: 'started' }.
    const payload = await this.request(
      'chat.send',
      {
        sessionKey,
        message: prompt,
        deliver: true,
        timeoutMs,
        idempotencyKey: uuidv4(),
      },
      { timeoutMs }
    );

    const runId =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).runId === 'string'
        ? ((payload as Record<string, unknown>).runId as string)
        : null;

    if (!runId) {
      // Fallback: no runId, return what we got.
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    }

    console.log(`📡 chat.send acknowledged — runId=${runId}, session=${sessionKey}, waiting for stream...`);
    return await this.waitForRun(runId, timeoutMs, sessionKey);
  }

  private waitForRun(runId: string, timeoutMs: number, sessionKey = ''): Promise<string> {
    const existing = this.pendingRuns.get(runId);
    if (existing) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for run ${runId}`)), timeoutMs);
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (text) => {
          clearTimeout(timer);
          prevResolve(text);
          resolve(text);
        };
        existing.reject = (err) => {
          clearTimeout(timer);
          prevReject(err);
          reject(err);
        };
      });
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuns.delete(runId);
        reject(new Error(`Timeout waiting for run ${runId}`));
      }, timeoutMs);

      this.pendingRuns.set(runId, { resolve, reject, latestText: '', sessionKey, timer });
    });
  }

  /**
   * Send a gateway request and await response.
   */
  private async request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = uuidv4();
    const frame: GatewayRequestFrame = { type: 'req', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response (method: ${method}, id: ${id})`));
      }, opts?.timeoutMs ?? 120000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify(frame), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to send request ${method}: ${err.message}`));
        }
      });
    });
  }

  private sendConnect(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.connectNonce) return;

    const signedAtMs = Date.now();
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write'];
    const token = this.token ?? undefined;
    const clientId = 'gateway-client';
    const clientMode = 'backend';

    const devicePayload = buildDeviceAuthPayload({
      deviceId: this.identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: token ?? null,
      nonce: this.connectNonce,
    });

    const device = {
      id: this.identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(this.identity.publicKeyPem),
      signature: signDevicePayload(this.identity.privateKeyPem, devicePayload),
      signedAt: signedAtMs,
      nonce: this.connectNonce,
    };

    void this.request(
      'connect',
      {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: 'dev',
          platform: process.platform,
          mode: clientMode,
        },
        role,
        scopes,
        auth: token ? { token } : undefined,
        device,
      },
      { timeoutMs: 5000 }
    ).catch((err) => {
      if (!this.isConnected) {
        this.connectReject?.(err instanceof Error ? err : new Error(String(err)));
      }
      this.ws?.close(1008, 'connect failed');
    });
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString()) as GatewayEventFrame | GatewayResponseFrame | Record<string, unknown>;

      if ((parsed as GatewayEventFrame).type === 'event') {
        const evt = parsed as GatewayEventFrame;
        if (evt.event === 'connect.challenge') {
          const payload = evt.payload as { nonce?: unknown } | undefined;
          const nonce = payload && typeof payload.nonce === 'string' ? payload.nonce.trim() : '';
          if (!nonce) {
            this.connectReject?.(new Error('gateway connect.challenge missing nonce'));
            this.ws?.close(1008, 'connect challenge missing nonce');
            return;
          }
          this.connectNonce = nonce;
          this.sendConnect();
          return;
        }

        if (evt.event === 'chat' || evt.event === 'chat.event') {
          const payload = evt.payload as
            | { runId?: unknown; sessionKey?: unknown; type?: unknown; state?: unknown; message?: unknown; text?: unknown; errorMessage?: unknown }
            | undefined;
          const runId = payload && typeof payload.runId === 'string' ? payload.runId : null;
          if (!runId) return;

          const pending = this.pendingRuns.get(runId);
          if (!pending) return;

          // FIX: sessionKey filtering — the gateway broadcasts chat events to ALL
          // connected clients (OpenClaw Issue #32579). Without this check, parallel
          // workflows receive each other's events and scramble the pipeline.
          const incomingSession = payload && typeof payload.sessionKey === 'string' ? payload.sessionKey : null;
          if (incomingSession && pending.sessionKey && incomingSession !== pending.sessionKey) {
            return; // Not our session — ignore
          }

          // Error shortcut
          if (payload?.errorMessage && typeof payload.errorMessage === 'string') {
            clearTimeout(pending.timer);
            this.pendingRuns.delete(runId);
            pending.reject(new Error(payload.errorMessage));
            return;
          }

          // Determine event kind: new-style payload.type ('delta'|'final') or old-style payload.state
          const evtType = payload && typeof payload.type === 'string' ? payload.type : '';
          const state = payload && typeof payload.state === 'string' ? payload.state : '';
          const isDelta = evtType === 'delta';
          const isFinal = evtType === 'final' || state === 'final' || state === 'aborted' || state === 'error';

          // Extract text chunk from various payload shapes
          const chunk = (() => {
            // Direct text field (new streaming format)
            if (payload?.text && typeof payload.text === 'string') return payload.text;
            const msg = payload?.message;
            if (typeof msg === 'string') return msg;
            if (!msg || typeof msg !== 'object') return '';
            const m = msg as Record<string, unknown>;
            if (typeof m.text === 'string') return m.text;
            if (typeof m.content === 'string') return m.content;
            // Handle OpenClaw format: { content: [{ type: 'text', text: '...' }] }
            if (Array.isArray(m.content)) {
              return (m.content as Array<{ type?: string; text?: string }>)
                .filter((c) => c.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('');
            }
            return JSON.stringify(msg);
          })();

          if (chunk) {
            if (isDelta) {
              // Streaming delta: append chunk to accumulated text
              pending.latestText += chunk;
              streamEvents.emit('chunk', { runId, sessionKey: pending.sessionKey, text: chunk });
            } else {
              // Final or old-style full replacement
              pending.latestText = chunk;
            }
          }

          if (isFinal) {
            console.log(`✅ Run ${runId} complete (${pending.latestText.length} chars)`);
            streamEvents.emit('final', { runId, sessionKey: pending.sessionKey, text: pending.latestText });
            clearTimeout(pending.timer);
            this.pendingRuns.delete(runId);
            pending.resolve(pending.latestText);
          }
          return;
        }

        // Handle lifecycle error events
        if (evt.event === 'lifecycle') {
          const payload = evt.payload as { runId?: unknown; phase?: unknown; error?: unknown } | undefined;
          const runId = payload && typeof payload.runId === 'string' ? payload.runId : null;
          if (!runId) return;
          const pending = this.pendingRuns.get(runId);
          if (!pending) return;

          if (payload?.phase === 'error') {
            const errMsg = typeof payload.error === 'string' ? payload.error : `Lifecycle error for run ${runId}`;
            console.error(`❌ Run ${runId} lifecycle error: ${errMsg}`);
            clearTimeout(pending.timer);
            this.pendingRuns.delete(runId);
            pending.reject(new Error(errMsg));
          }
          return;
        }
        return;
      }

      if ((parsed as GatewayResponseFrame).type === 'res') {
        const resFrame = parsed as GatewayResponseFrame;
        const pending = this.pendingRequests.get(resFrame.id);
        if (!pending) return;

        // In OpenClaw 2026.3.1+, chat.send is non-blocking.
        // Resolve immediately — no more waiting for 'accepted' status.
        clearTimeout(pending.timer);
        this.pendingRequests.delete(resFrame.id);

        if (!resFrame.ok) {
          const msg = resFrame.error?.message || 'Unknown gateway error';
          pending.reject(new Error(msg));
          if (!this.isConnected) {
            this.connectReject?.(new Error(msg));
          }
          return;
        }

        // If this is the connect response (hello-ok), mark connected
        const payload = resFrame.payload as { type?: unknown } | undefined;
        if (!this.isConnected && payload && payload.type === 'hello-ok') {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.connectPromise = null;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectResolve?.();
        }

        pending.resolve(resFrame.payload);
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
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    // Also reject pending streaming runs
    for (const [runId, pending] of this.pendingRuns) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRuns.clear();
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
