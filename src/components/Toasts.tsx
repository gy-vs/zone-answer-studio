export interface Toast {
  id: string;
  kind: "error" | "success" | "info";
  text: string;
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} style={{ whiteSpace: "pre-wrap" }}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
