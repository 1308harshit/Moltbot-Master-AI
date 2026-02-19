import type {
  StepStatus,
  StepOutputData,
} from '../types';
import {
  STEP_PREREQUISITES,
  API_BASE,
} from '../types';
import SessionGrid from './SessionGrid';

interface StepCardProps {
  stepKey: string;
  label: string;
  description: string;
  stepStatus: StepStatus;
  allStepStatuses: Record<string, StepStatus>;
  outputs: StepOutputData[];
  gapId: string | null;
  selectedSession: number | null;
  onSelectSession: (step: string, session: number) => void;
}

const StepCard: React.FC<StepCardProps> = ({
  stepKey,
  label,
  description,
  stepStatus,
  allStepStatuses,
  outputs,
  gapId,
  selectedSession,
  onSelectSession,
}) => {
  // Check prerequisites to determine if step is locked
  const prereqs = STEP_PREREQUISITES[stepKey] || [];
  const isLocked = prereqs.some((p) => {
    const ps = allStepStatuses[p];
    return !ps || ps.status !== 'completed';
  });

  const isRunning = stepStatus.status === 'running';
  const hasFailed = stepStatus.failedSessions.length > 0;
  const isIdle = stepStatus.status === 'idle';

  const stepOutputs = outputs.filter((o) => o.step === stepKey);

  const runStep = async () => {
    if (!gapId || isLocked || isRunning) return;
    try {
      await fetch(`${API_BASE}/api/workflow/${gapId}/step/${stepKey}/run`, {
        method: 'POST',
      });
    } catch (e) {
      console.error(`Failed to run ${stepKey}:`, e);
    }
  };

  const rerunFailed = async () => {
    if (!gapId || !hasFailed) return;
    try {
      await fetch(`${API_BASE}/api/workflow/${gapId}/step/${stepKey}/rerun-failed`, {
        method: 'POST',
      });
    } catch (e) {
      console.error(`Failed to rerun ${stepKey}:`, e);
    }
  };

  return (
    <div className={`step-card ${isLocked ? 'step-locked' : ''} ${isRunning ? 'step-running' : ''} ${hasFailed ? 'step-has-failure' : ''}`}>
      <div className="step-card-header">
        <div className="step-card-title">
          <h3>{label}</h3>
          <span className="step-description">{description}</span>
        </div>

        <div className="step-card-meta">
          <div className={`status-badge status-${stepStatus.status}`}>
            <span className="status-dot" />
            {stepStatus.status}
          </div>

          {hasFailed && (
            <span className="failure-badge">
              ⚠ {stepStatus.failedSessions.length} failed
            </span>
          )}

          <span className="step-progress-text">
            {stepStatus.completedSessions}/{stepStatus.totalSessions}
          </span>
        </div>
      </div>

      <div className="step-card-controls">
        <button
          className="btn btn-primary btn-sm"
          onClick={runStep}
          disabled={isLocked || isRunning || !gapId}
          title={isLocked ? 'Complete prerequisite steps first' : ''}
        >
          {isRunning ? '⏳ Running...' : '▶ Run Step'}
        </button>

        <button
          className="btn btn-secondary btn-sm"
          onClick={rerunFailed}
          disabled={!hasFailed || isRunning || !gapId}
        >
          🔁 Re-run Failed
        </button>

        {isLocked && (
          <span className="lock-label">
            🔒 Requires: {prereqs.join(', ')}
          </span>
        )}
      </div>

      {/* Session Grid */}
      {!isIdle && (
        <SessionGrid
          stepKey={stepKey}
          totalSessions={stepStatus.totalSessions}
          completedSessions={stepStatus.completedSessions}
          failedSessions={stepStatus.failedSessions}
          stepStatus={stepStatus.status}
          outputs={stepOutputs.map((o) => ({
            session: o.session,
            validationPassed: o.validationPassed,
            output: o.output,
          }))}
          selectedSession={selectedSession}
          onSelectSession={(session) => onSelectSession(stepKey, session)}
        />
      )}

      {/* Progress bar */}
      {stepStatus.totalSessions > 1 && !isIdle && (
        <div className="progress-bar-container" style={{ marginTop: '0.5rem' }}>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${(stepStatus.completedSessions / stepStatus.totalSessions) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default StepCard;
