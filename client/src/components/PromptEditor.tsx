import type { FC } from 'react';
import { useState, useEffect } from 'react';
import { API_BASE } from '../types';

const PROMPT_KEYS = [
  { key: 'default_prompt_boot', label: 'Boot Prompt' },
  { key: 'default_prompt_step1', label: 'Step 1 Prompt' },
  { key: 'default_prompt_step2a', label: 'Step 2a Prompt' },
  { key: 'default_prompt_step2b', label: 'Step 2b Prompt' },
  { key: 'default_prompt_step2c', label: 'Step 2c Prompt' },
  { key: 'default_prompt_step3', label: 'Step 3 Prompt' },
];

interface PromptMeta {
  value: string;
  lastUpdated: number | null;
  version: number;
}

interface PromptEditorProps {
  disabled?: boolean;
}

const PromptEditor: FC<PromptEditorProps> = ({ disabled }) => {
  const [prompts, setPrompts] = useState<Record<string, PromptMeta>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    // Load server defaults
    fetch(`${API_BASE}/api/prompts`)
      .then((res) => res.json())
      .then((serverData) => {
        setDefaults(serverData);

        // Load local overrides
        const stored = localStorage.getItem('moltbot-prompts-v2');
        let localMeta: Record<string, PromptMeta> = {};
        if (stored) {
          try { localMeta = JSON.parse(stored); } catch (_) { /* ignore */ }
        }

        // Merge: local overrides on top of server defaults
        const merged: Record<string, PromptMeta> = {};
        for (const { key } of PROMPT_KEYS) {
          merged[key] = localMeta[key] || {
            value: serverData[key] || '',
            lastUpdated: null,
            version: 0,
          };
        }
        setPrompts(merged);
      })
      .catch(() => {
        const stored = localStorage.getItem('moltbot-prompts-v2');
        if (stored) {
          try { setPrompts(JSON.parse(stored)); } catch (_) { /* ignore */ }
        }
      });
  }, []);

  const toggleOpen = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updatePrompt = (key: string, value: string) => {
    const updated: Record<string, PromptMeta> = {
      ...prompts,
      [key]: {
        value,
        lastUpdated: Date.now(),
        version: (prompts[key]?.version || 0) + 1,
      },
    };
    setPrompts(updated);
    localStorage.setItem('moltbot-prompts-v2', JSON.stringify(updated));
  };

  const resetToDefault = (key: string) => {
    const defaultVal = defaults[key] || '';
    updatePrompt(key, defaultVal);
  };

  const saveToServer = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [key, meta] of Object.entries(prompts)) {
        payload[key] = meta.value;
      }
      await fetch(`${API_BASE}/api/prompts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error('Failed to save prompts:', e);
    }
    setSaving(false);
  };

  return (
    <div className="card">
      <div
        className="card-title"
        style={{ cursor: 'pointer' }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="icon">✏️</span>
        Prompt Templates
        <span className={`collapsible-chevron ${!collapsed ? 'open' : ''}`} style={{ marginLeft: 'auto' }}>
          ▼
        </span>
      </div>

      {!collapsed && (
        <>
          {PROMPT_KEYS.map(({ key, label }) => {
            const meta = prompts[key];
            return (
              <div className="collapsible" key={key}>
                <div className="collapsible-header" onClick={() => toggleOpen(key)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
                    <span>{label}</span>
                    {meta?.version > 0 && (
                      <span className="prompt-version">v{meta.version}</span>
                    )}
                    {meta?.lastUpdated && (
                      <span className="prompt-timestamp">
                        {new Date(meta.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <span className={`collapsible-chevron ${openKeys.has(key) ? 'open' : ''}`}>▼</span>
                </div>
                {openKeys.has(key) && (
                  <div className="collapsible-body">
                    <textarea
                      className="textarea"
                      placeholder={`{${key}} — edit the prompt template here...`}
                      value={meta?.value || ''}
                      onChange={(e) => updatePrompt(key, e.target.value)}
                      disabled={disabled}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => resetToDefault(key)}
                        disabled={disabled}
                      >
                        ↩️ Reset
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ marginTop: '0.75rem' }}>
            <button
              className="btn btn-secondary"
              onClick={saveToServer}
              disabled={disabled || saving}
            >
              {saving ? '⏳ Saving...' : '💾 Save to Server'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default PromptEditor;
