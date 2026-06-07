import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Html } from '@react-three/drei';

interface Props {
  children: ReactNode;
  modelName: string;
  onRetry?: () => void;
  language?: string;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ModelErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { 
      hasError: true, 
      errorMessage: error.message || 'Unknown loading error' 
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ModelErrorBoundary caught an error:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, errorMessage: '' });
    if (this.onRetry) {
      this.onRetry();
    }
  };

  private get onRetry() {
    return this.props.onRetry;
  }

  render() {
    if (this.state.hasError) {
      const isHe = this.props.language === 'he';
      
      const title = isHe ? 'שגיאה בטעינת המודל' : 'Error Loading Model';
      const description = isHe
        ? 'קובץ ה-3D פגום או שלא הושלם בהצלחה. לחץ כדי לנסות שנית.'
        : 'The 3D asset file is corrupted or incomplete. Click to clean cache and retry.';
      const buttonText = isHe ? 'נסה שוב' : 'Retry Load';

      return (
        <Html center>
          <div 
            className="bg-white/95 backdrop-blur-md p-6 rounded-3xl shadow-2xl border border-red-100 flex flex-col items-center text-center max-w-sm pointer-events-auto"
            dir={isHe ? 'rtl' : 'ltr'}
          >
            <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-4 text-red-500 animate-bounce">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="font-bold text-zinc-900 text-sm mb-2 uppercase tracking-wide">
              {title}
            </h3>
            <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed font-medium">
              {description}
            </p>
            {this.state.errorMessage && (
              <code className="text-[9px] bg-red-50 text-red-600 px-3 py-1.5 rounded-lg mb-4 font-mono max-w-full overflow-x-auto block">
                {this.state.errorMessage}
              </code>
            )}
            <button
              onClick={this.handleRetry}
              className="px-6 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-[10px] font-bold uppercase tracking-widest shadow-md shadow-red-500/20 active:scale-95 transition-all"
            >
              {buttonText}
            </button>
          </div>
        </Html>
      );
    }

    return this.props.children;
  }
}
