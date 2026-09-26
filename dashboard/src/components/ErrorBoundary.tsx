import { Component, type ReactNode } from "react";

// A rendering bug shows a readable message instead of a blank window.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-screen">
        <div className="card">
          <h2>משהו השתבש בתצוגה</h2>
          <pre className="error-pre" dir="ltr">{this.state.error.message}</pre>
          <button className="primary" onClick={() => location.reload()}>טעינה מחדש</button>
        </div>
      </div>
    );
  }
}
