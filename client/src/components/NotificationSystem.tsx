import type { Notification } from '../types';

interface NotificationSystemProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  onClear: () => void;
}

const NotificationSystem: React.FC<NotificationSystemProps> = ({
  notifications,
  onDismiss,
  onClear,
}) => {
  const visible = notifications.filter((n) => !n.dismissed);
  const activeModal = visible.find((n) => n.level === 'error' && !n.dismissed);

  if (visible.length === 0) return null;

  return (
    <>
      {/* Toast stack (top-right) */}
      <div className="notification-stack">
        {visible.slice(0, 5).map((notif) => (
          <div
            key={notif.id}
            className={`notification-toast notification-${notif.level}`}
          >
            <div className="notification-content">
              <div className="notification-header">
                <span className="notification-icon">
                  {notif.level === 'error' && '❌'}
                  {notif.level === 'success' && '✅'}
                  {notif.level === 'warning' && '⚠️'}
                  {notif.level === 'info' && 'ℹ️'}
                </span>
                <strong>{notif.title}</strong>
                <button
                  className="notification-close"
                  onClick={() => onDismiss(notif.id)}
                >
                  ×
                </button>
              </div>
              <p className="notification-message">{notif.message}</p>
              {notif.step && (
                <span className="notification-meta">
                  Step: {notif.step}
                  {notif.failedSession && ` • Panel ${notif.failedSession}`}
                </span>
              )}
            </div>
          </div>
        ))}

        {visible.length > 1 && (
          <button className="btn btn-secondary btn-sm notification-clear" onClick={onClear}>
            Clear All
          </button>
        )}
      </div>

      {/* Modal popup for critical failures */}
      {activeModal && (
        <div className="toast-overlay" onClick={() => onDismiss(activeModal.id)}>
          <div className="toast-box" onClick={(e) => e.stopPropagation()}>
            <h3>⚠️ {activeModal.title}</h3>
            <p>{activeModal.message}</p>
            {activeModal.step && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Step: {activeModal.step}
                {activeModal.failedSession && ` • Panel ${activeModal.failedSession}`}
              </p>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => onDismiss(activeModal.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default NotificationSystem;
