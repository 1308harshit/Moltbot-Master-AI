import { useEffect, useState } from 'react';
import type {
  StepStatus,
} from './types';
import {
  STEP_DEFINITIONS,
  API_BASE,
} from './types';
import { useWorkflowSocket } from './hooks/useWorkflowSocket';
import GapIdBanner from './components/GapIdBanner';
import ContextInput from './components/ContextInput';
import StepCard from './components/StepCard';
import OutputViewer from './components/OutputViewer';
import PromptEditor from './components/PromptEditor';
import NotificationSystem from './components/NotificationSystem';
import WorkflowHistory from './components/WorkflowHistory';
import './App.css';

const DEFAULT_STEP_STATUS: StepStatus = {
  status: 'idle',
  completedSessions: 0,
  failedSessions: [],
  totalSessions: 6,
};

function App() {
  const [contextBlock, setContextBlock] = useState('');
  const [activeGapId, setActiveGapId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<number | null>(null);
  const [multibotConnected, setMultibotConnected] = useState(false);

  const {
    workflowData,
    notifications,
    connected,
    dismissNotification,
    clearNotifications,
  } = useWorkflowSocket(activeGapId);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/multibot/health`, { cache: 'no-store' });
        const ok = res.ok;
        if (!cancelled) setMultibotConnected(ok);
      } catch {
        if (!cancelled) setMultibotConnected(false);
      }
    };

    poll();
    timer = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Hydrate the context block input when a historical workflow is selected
  useEffect(() => {
    if (workflowData?.contextBlock) {
      setContextBlock(workflowData.contextBlock);
    }
  }, [workflowData?.contextBlock]);

  const isRunning = workflowData?.status === 'running';

  const startWorkflow = async () => {
    if (!contextBlock.trim()) {
      alert('Please enter a context block.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/workflow/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextBlock }),
      });
      const data = await res.json();
      if (data.success && data.gapId) {
        setActiveGapId(data.gapId);
        setSelectedStep(null);
        setSelectedSession(null);
      } else {
        alert(`Failed: ${data.error || 'Unknown error'}`);
      }
    } catch (error) {
      alert(`Network error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSelectWorkflow = (gapId: string) => {
    setActiveGapId(gapId);
    setSelectedStep(null);
    setSelectedSession(null);
  };

  const handleWorkflowDeleted = (gapId: string) => {
    // If the currently viewed workflow was deleted, reset the view
    if (activeGapId === gapId) {
      setActiveGapId(null);
      setSelectedStep(null);
      setSelectedSession(null);
    }
  };

  const handleSelectSession = (step: string, session: number) => {
    setSelectedStep(step);
    setSelectedSession(session);
  };

  const getStepStatus = (stepKey: string): StepStatus => {
    if (!workflowData?.stepStatuses) return DEFAULT_STEP_STATUS;
    const statuses = workflowData.stepStatuses as Record<string, StepStatus>;
    return statuses[stepKey] || DEFAULT_STEP_STATUS;
  };

  // Filter outputs for selected step/session
  const filteredOutputs = workflowData?.stepOutputs || [];

  return (
    <div className="app">
      {/* Gap ID Banner */}
      <GapIdBanner workflow={workflowData} connected={connected} multibotConnected={multibotConnected} />

      <div className="app-header">
        <h1>MoltBot Orchestrator</h1>
        <p>Research Workflow Management Dashboard</p>
      </div>

      <div className="sidebar-layout">
        {/* Left Sidebar — History */}
        <aside className="sidebar-left">
          <WorkflowHistory
            activeGapId={activeGapId}
            onSelectWorkflow={handleSelectWorkflow}
            onWorkflowDeleted={handleWorkflowDeleted}
          />
        </aside>

        {/* Main Content */}
        <main className="main-content">
          {/* Context + Start */}
          <div className="grid-layout">
            <div>
              <ContextInput
                value={contextBlock}
                onChange={setContextBlock}
                disabled={isRunning}
              />
            </div>
            <div>
              <div className="card">
                <div className="card-title">
                  <span className="icon">🚀</span>
                  Launch Area
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setActiveGapId(null);
                      startWorkflow();
                    }}
                    disabled={isRunning || !contextBlock.trim()}
                  >
                    {isRunning && !activeGapId ? '⏳ Running...' : '🚀 Start New Workflow'}
                  </button>
                  
                  {activeGapId && workflowData && workflowData.status !== 'running' && (
                    <button
                      className="btn btn-secondary"
                      onClick={startWorkflow}
                      disabled={!contextBlock.trim()}
                      style={{ backgroundColor: 'var(--bg-card-hover)' }}
                    >
                      🔄 Rerun This Context
                    </button>
                  )}
                  
                  {activeGapId && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setActiveGapId(null);
                        setContextBlock('');
                      }}
                      style={{ border: '1px solid var(--border-color)', backgroundColor: 'transparent' }}
                    >
                      ➕ New Blank Form
                    </button>
                  )}
                </div>
                {!contextBlock.trim() && (
                  <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    ⚠️ Enter a context block to start
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Step Cards */}
          <div className="step-cards-container">
            {STEP_DEFINITIONS.map((stepDef) => (
              <StepCard
                key={stepDef.key}
                stepKey={stepDef.key}
                label={stepDef.label}
                description={stepDef.description}
                stepStatus={getStepStatus(stepDef.key)}
                allStepStatuses={
                  (workflowData?.stepStatuses as Record<string, StepStatus>) || {}
                }
                outputs={filteredOutputs}
                gapId={activeGapId}
                selectedSession={selectedStep === stepDef.key ? selectedSession : null}
                onSelectSession={handleSelectSession}
              />
            ))}
          </div>

          {/* Output Viewer */}
          <OutputViewer
            outputs={filteredOutputs}
            selectedStep={selectedStep}
            selectedSession={selectedSession}
          />

          {/* Prompt Editor (collapsible at bottom) */}
          <PromptEditor disabled={isRunning} />
        </main>
      </div>

      {/* Notification System */}
      <NotificationSystem
        notifications={notifications}
        onDismiss={dismissNotification}
        onClear={clearNotifications}
      />
    </div>
  );
}

export default App;
