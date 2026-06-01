import { Component, type ReactNode } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { log } from '../../lib/logger'

interface Props {
  children: ReactNode
  fallbackClassName?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    log.error('ErrorBoundary caught', { error, componentStack: info.componentStack })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={this.props.fallbackClassName || 'flex flex-col items-center justify-center p-6 gap-3'}>
          <AlertCircle size={24} className="text-red-400" />
          <p className="text-sm text-red-400 text-center">Something went wrong</p>
          <p className="text-xs text-gray-500 text-center max-w-[200px] break-words">
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
