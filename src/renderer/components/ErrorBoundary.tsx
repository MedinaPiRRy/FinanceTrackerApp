import { Component, type ErrorInfo, type ReactNode } from 'react'

/** If a screen crashes, show a calm message instead of a blank window. Data is never affected by a display error. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen error:', error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }) // navigating elsewhere clears it
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card" role="alert" style={{ maxWidth: 640 }}>
        <h2>Something went wrong showing this page</h2>
        <p className="sub">Your data is safe: this is only a display problem. Try another page, or reload with Ctrl+R.</p>
        <details><summary className="muted">Technical details</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre></details>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
