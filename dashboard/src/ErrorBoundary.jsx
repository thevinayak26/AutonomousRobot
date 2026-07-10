// -----------------------------------------------------------------------------
// ErrorBoundary.jsx - defense in depth. A throw in render or a passive effect
// (e.g. a transient roslib/WebSocket race) otherwise unmounts the whole tree and
// leaves a blank page with no on-screen clue. This catches it and shows the
// error so failures are visible in the browser, not just the console.
// -----------------------------------------------------------------------------
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: 'monospace', padding: 24, color: '#fb7185' }}>
          <h1 style={{ fontFamily: 'serif' }}>Dashboard crashed</h1>
          <p>The UI threw an error and was caught by the error boundary:</p>
          <pre style={{ background: '#11161d', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap', maxWidth: 640 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: '6px 14px', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
