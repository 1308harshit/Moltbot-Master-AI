import type { WorkflowData } from '../types';

interface GapIdBannerProps {
  workflow: WorkflowData | null;
  connected: boolean;
}

const GapIdBanner: React.FC<GapIdBannerProps> = ({ workflow, connected }) => {
  const statusClass = workflow ? `status-${workflow.status}` : 'status-idle';
  const statusLabel = workflow
    ? workflow.status.charAt(0).toUpperCase() + workflow.status.slice(1)
    : 'Idle';

  const elapsed = workflow
    ? getElapsed(new Date(workflow.createdAt))
    : null;

  return (
    <div className="gap-banner">
      <div className="gap-banner-left">
        <span className="gap-label">Current GAP:</span>
        <span className="gap-id">
          {workflow ? workflow.gapId.substring(0, 8).toUpperCase() : '—'}
        </span>
      </div>

      <div className="gap-banner-center">
        <div className={`status-badge ${statusClass}`}>
          <span className="status-dot" />
          {statusLabel}
        </div>
        {workflow && (
          <span className="gap-step">
            Step: <strong>{workflow.currentStep}</strong>
          </span>
        )}
        {elapsed && (
          <span className="gap-elapsed">⏱️ {elapsed}</span>
        )}
      </div>

      <div className="gap-banner-right">
        <div className={`ws-indicator ${connected ? 'ws-connected' : 'ws-disconnected'}`}>
          <span className="ws-dot" />
          {connected ? 'Live' : 'Offline'}
        </div>
      </div>
    </div>
  );
};

function getElapsed(start: Date): string {
  const diff = Math.floor((Date.now() - start.getTime()) / 1000);
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export default GapIdBanner;
