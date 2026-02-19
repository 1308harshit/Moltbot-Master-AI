import { useState, useEffect } from 'react';
import type { StepOutputData } from '../types';
import { STEP_DEFINITIONS } from '../types';

interface OutputViewerProps {
  outputs: StepOutputData[];
  selectedStep: string | null;
  selectedSession: number | null;
}

const OutputViewer: React.FC<OutputViewerProps> = ({
  outputs,
  selectedStep,
  selectedSession,
}) => {
  const [activeStep, setActiveStep] = useState<string | null>(selectedStep);
  const [activeSession, setActiveSession] = useState<number | null>(selectedSession);

  // Sync with external selection
  useEffect(() => {
    if (selectedStep) setActiveStep(selectedStep);
    if (selectedSession !== null) setActiveSession(selectedSession);
  }, [selectedStep, selectedSession]);

  if (outputs.length === 0) {
    return (
      <div className="card full-width">
        <div className="card-title">
          <span className="icon">📄</span>
          Output Viewer
        </div>
        <div className="tab-content" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          No outputs yet. Start a workflow to see panel responses here.
        </div>
      </div>
    );
  }

  // Group by step
  const stepGroups: Record<string, StepOutputData[]> = {};
  outputs.forEach((o) => {
    if (!stepGroups[o.step]) stepGroups[o.step] = [];
    stepGroups[o.step].push(o);
  });

  const availableSteps = Object.keys(stepGroups);
  const currentStep = activeStep && stepGroups[activeStep] ? activeStep : availableSteps[0];
  const stepOutputs = stepGroups[currentStep] || [];

  // Group sessions within step
  const sessions = Array.from(new Set(stepOutputs.map((o) => o.session))).sort((a, b) => a - b);
  const currentSession = activeSession && sessions.includes(activeSession) ? activeSession : sessions[0];
  const activeOutput = stepOutputs.find((o) => o.session === currentSession);

  const stepDef = STEP_DEFINITIONS.find((d) => d.key === currentStep);

  return (
    <div className="card full-width">
      <div className="card-title">
        <span className="icon">📄</span>
        Output Viewer
        {stepDef && (
          <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: '0.5rem' }}>
            — {stepDef.label}
          </span>
        )}
      </div>

      {/* Step tabs */}
      {availableSteps.length > 1 && (
        <div className="tabs" style={{ marginBottom: '0.5rem' }}>
          {availableSteps.map((step) => {
            const def = STEP_DEFINITIONS.find((d) => d.key === step);
            return (
              <div
                key={step}
                className={`tab ${currentStep === step ? 'active' : ''}`}
                onClick={() => { setActiveStep(step); setActiveSession(null); }}
              >
                {def?.label || step}
              </div>
            );
          })}
        </div>
      )}

      {/* Session tabs */}
      <div className="tabs">
        {sessions.map((session) => {
          const output = stepOutputs.find((o) => o.session === session);
          const statusIcon = output?.validationPassed ? '✅' : output?.output ? '❌' : '⏳';
          return (
            <div
              key={session}
              className={`tab ${currentSession === session ? 'active' : ''}`}
              onClick={() => setActiveSession(session)}
            >
              {statusIcon} Panel {session}
            </div>
          );
        })}
      </div>

      {activeOutput ? (
        <>
          <div className="indicators" style={{ marginBottom: '0.75rem' }}>
            <div className="indicator">
              <span
                className={`dot ${activeOutput.validationPassed ? 'dot-green' : 'dot-red'}`}
              />
              {activeOutput.validationPassed ? 'Validation Passed' : 'Validation Failed'}
            </div>
            <div className="indicator">
              <span
                className={`dot ${activeOutput.storedInCoda ? 'dot-green' : 'dot-gray'}`}
              />
              {activeOutput.storedInCoda ? 'Synced to Coda' : 'Not synced'}
            </div>
            <div className="indicator" style={{ color: 'var(--text-muted)' }}>
              {new Date(activeOutput.createdAt).toLocaleTimeString()}
            </div>
          </div>
          <div className="tab-content">{activeOutput.output || '(empty response)'}</div>
        </>
      ) : (
        <div className="tab-content" style={{ color: 'var(--text-muted)' }}>
          Select a panel tab to view output.
        </div>
      )}
    </div>
  );
};

export default OutputViewer;
