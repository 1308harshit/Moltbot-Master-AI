import { useState, useEffect, useCallback, useRef } from 'react';
import type { WorkflowData, WSEvent, Notification } from '../types';
import { WS_URL, API_BASE } from '../types';

interface UseWorkflowSocketReturn {
  workflowData: WorkflowData | null;
  notifications: Notification[];
  connected: boolean;
  fetchWorkflow: (gapId: string) => Promise<void>;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
}

export function useWorkflowSocket(activeGapId: string | null): UseWorkflowSocketReturn {
  const [workflowData, setWorkflowData] = useState<WorkflowData | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch full workflow data via REST (initial load + manual refresh)
  const fetchWorkflow = useCallback(async (gapId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/workflow/${gapId}/status`);
      if (res.ok) {
        const data: WorkflowData = await res.json();
        setWorkflowData(data);
      }
    } catch (e) {
      console.error('Fetch workflow error:', e);
    }
  }, []);

  // Connect to WebSocket
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('🔌 Connected to orchestrator WS');
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const wsEvent: WSEvent = JSON.parse(event.data);

          // Only process events for the active workflow
          if (activeGapId && wsEvent.gapId !== activeGapId) return;

          switch (wsEvent.type) {
            case 'workflow:update':
            case 'step:update':
            case 'session:update':
              // Refetch full state to stay consistent
              if (activeGapId) {
                fetchWorkflow(activeGapId);
              }
              break;

            case 'notification': {
              const notif: Notification = {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                level: (wsEvent.data.level as Notification['level']) || 'info',
                title: (wsEvent.data.title as string) || 'Notification',
                message: (wsEvent.data.message as string) || '',
                step: wsEvent.data.step as string | undefined,
                failedSession: wsEvent.data.failedSession as number | undefined,
                timestamp: Date.now(),
                dismissed: false,
              };
              setNotifications((prev) => [notif, ...prev]);

              // Auto-dismiss success notifications after 5 seconds
              if (notif.level === 'success') {
                setTimeout(() => {
                  setNotifications((prev) =>
                    prev.map((n) => (n.id === notif.id ? { ...n, dismissed: true } : n))
                  );
                }, 5000);
              }
              break;
            }
          }
        } catch (e) {
          console.error('WS message parse error:', e);
        }
      };

      ws.onclose = () => {
        console.log('🔌 WS disconnected, reconnecting...');
        setConnected(false);
        reconnectTimer.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        setConnected(false);
      };
    };

    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, [activeGapId, fetchWorkflow]);

  // Initial fetch when gapId changes
  useEffect(() => {
    if (activeGapId) {
      fetchWorkflow(activeGapId);
    } else {
      setWorkflowData(null);
    }
  }, [activeGapId, fetchWorkflow]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed: true } : n)));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return {
    workflowData,
    notifications,
    connected,
    fetchWorkflow,
    dismissNotification,
    clearNotifications,
  };
}
