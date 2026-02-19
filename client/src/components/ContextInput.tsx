import type { FC } from 'react';

interface ContextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const ContextInput: FC<ContextInputProps> = ({ value, onChange, disabled }) => {
  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">📋</span>
        Context Block
      </div>
      <textarea
        className="textarea"
        placeholder="Paste your context block here...&#10;&#10;This will be injected into each prompt alongside the default template."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={8}
      />
    </div>
  );
};

export default ContextInput;
