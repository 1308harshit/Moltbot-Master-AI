import type { WorkflowHistoryItem } from '../types';
import { API_BASE } from '../types';
import { useState, useEffect } from 'react';

interface WorkflowHistoryProps {
  activeGapId: string | null;
  onSelectWorkflow: (gapId: string) => void;
  onWorkflowDeleted?: (gapId: string) => void;
}

const WorkflowHistory: React.FC<WorkflowHistoryProps> = ({
  activeGapId,
  onSelectWorkflow,
  onWorkflowDeleted,
}) => {
  const [workflows, setWorkflows] = useState<WorkflowHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

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
    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeGapId) {
      fetchHistory();
    }
  }, [activeGapId]);

  const handleStop = async (e: React.MouseEvent, gapId: string) => {
    e.stopPropagation();
    if (actionInProgress) return;
    setActionInProgress(gapId + ':stop');
    try {
      const res = await fetch(`${API_BASE}/api/workflow/${gapId}/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Stop failed');
      await fetchHistory();
    } catch (err) {
      alert(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDelete = async (e: React.MouseEvent, gapId: string) => {
    e.stopPropagation();
    if (actionInProgress) return;
    if (!confirm(`Delete workflow ${gapId.substring(0, 8).toUpperCase()}? This cannot be undone.`)) return;
    setActionInProgress(gapId + ':delete');
    try {
      const res = await fetch(`${API_BASE}/api/workflow/${gapId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      // Notify parent if the deleted one was selected
      if (gapId === activeGapId) onWorkflowDeleted?.(gapId);
      await fetchHistory();
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionInProgress(null);
    }
  };

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
          const isRunning = wf.status === 'running';
          const shortId = wf.gapId.substring(0, 8).toUpperCase();
          const time = new Date(wf.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          const isBusy = actionInProgress?.startsWith(wf.gapId);

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

              {/* Action buttons */}
              <div className="history-actions" onClick={(e) => e.stopPropagation()}>
                {isRunning && (
                  <button
                    className="history-btn history-btn-stop"
                    title="Stop workflow"
                    disabled={!!isBusy}
                    onClick={(e) => handleStop(e, wf.gapId)}
                  >
                    {actionInProgress === wf.gapId + ':stop' ? '…' : '⏹'}
                  </button>
                )}
                <button
                  className="history-btn history-btn-delete"
                  title="Delete workflow"
                  disabled={!!isBusy}
                  onClick={(e) => handleDelete(e, wf.gapId)}
                >
                  {actionInProgress === wf.gapId + ':delete' ? '…' : '🗑'}
                </button>
              </div>

              {isActive && <span className="history-active-marker">←</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default WorkflowHistory;
