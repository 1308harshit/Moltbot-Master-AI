import type { WorkflowHistoryItem } from '../types';
import { API_BASE } from '../types';
import { useState, useEffect } from 'react';

interface WorkflowHistoryProps {
  activeGapId: string | null;
  onSelectWorkflow: (gapId: string) => void;
}

const WorkflowHistory: React.FC<WorkflowHistoryProps> = ({
  activeGapId,
  onSelectWorkflow,
}) => {
  const [workflows, setWorkflows] = useState<WorkflowHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/workflows`);
      if (res.ok) {
        const data: WorkflowHistoryItem[] = await res.json();
        setWorkflows(data);
      }
    } catch (e) {
      console.error('Failed to fetch workflow history:', e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchHistory();
    // Refresh every 15 seconds
    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, []);

  // Also refresh when activeGapId changes (new workflow started)
  useEffect(() => {
    if (activeGapId) {
      fetchHistory();
    }
  }, [activeGapId]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✅';
      case 'failed':    return '❌';
      case 'running':   return '🔄';
      default:          return '⚪';
    }
  };

  return (
    <div className="card history-panel">
      <div className="card-title">
        <span className="icon">📜</span>
        Workflow History
      </div>

      {loading && workflows.length === 0 && (
        <div className="history-loading">Loading...</div>
      )}

      {workflows.length === 0 && !loading && (
        <div className="history-empty">No workflows yet</div>
      )}

      <div className="history-list">
        {workflows.map((wf) => {
          const isActive = activeGapId === wf.gapId;
          const shortId = wf.gapId.substring(0, 8).toUpperCase();
          const time = new Date(wf.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={wf.gapId}
              className={`history-item ${isActive ? 'history-active' : ''}`}
              onClick={() => onSelectWorkflow(wf.gapId)}
            >
              <span className="history-icon">{statusIcon(wf.status)}</span>
              <div className="history-details">
                <span className="history-id">{shortId}</span>
                <span className="history-time">{time}</span>
              </div>
              <span className={`history-status history-status-${wf.status}`}>
                {wf.status}
              </span>
              {isActive && <span className="history-active-marker">←</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default WorkflowHistory;
