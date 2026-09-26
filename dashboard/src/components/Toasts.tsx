export type Toast = { id: string; title: string; body: string; tone: "good" | "bad" | "info" };

// Live-lead toasts, newest on top. Each carries an icon + words, never colour alone.
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.tone}`} onClick={() => onDismiss(t.id)} title="סגירה">
          <span className="toast-title">{t.title}</span>
          <span className="toast-body">{t.body}</span>
        </button>
      ))}
    </div>
  );
}
