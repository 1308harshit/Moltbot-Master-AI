import type { FC } from 'react';
import type { StepStatusType } from '../types';

interface SessionGridProps {
  stepKey: string;
  totalSessions: number;
  completedSessions: number;
  failedSessions: number[];
  stepStatus: StepStatusType;
  outputs: Array<{
    session: number;
    validationPassed: boolean;
    output: string;
  }>;
  selectedSession: number | null;
  onSelectSession: (session: number) => void;
}

const SessionGrid: FC<SessionGridProps> = ({
  stepKey,
  totalSessions,
  failedSessions,
  stepStatus,
  outputs,
  selectedSession,
  onSelectSession,
}) => {
  const sessions = Array.from({ length: totalSessions }, (_, i) => i + 1);

  const getSessionStatus = (session: number): StepStatusType => {
    if (failedSessions.includes(session)) return 'failed';
    const output = outputs.find((o) => o.session === session);
    if (output?.validationPassed) return 'completed';
    if (output && !output.validationPassed) return 'failed';
    if (stepStatus === 'running') {
      // Check if this panel has output yet
      return output ? 'completed' : 'running';
    }
    return 'idle';
  };

  return (
    <div className="session-grid">
      {sessions.map((session) => {
        const status = getSessionStatus(session);
        const isSelected = selectedSession === session;
        return (
          <div
            key={`${stepKey}-${session}`}
            className={`session-cell session-${status} ${isSelected ? 'session-selected' : ''}`}
            onClick={() => onSelectSession(session)}
            title={`Panel ${session} — ${status}`}
          >
            <span className="session-number">{session}</span>
            <span className="session-status-icon">
              {status === 'completed' && '✓'}
              {status === 'failed' && '✗'}
              {status === 'running' && '⟳'}
              {status === 'idle' && '·'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default SessionGrid;
