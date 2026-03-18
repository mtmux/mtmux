"use client";

import React from "react";
import { AlertTriangle, RefreshCw, Copy, RotateCcw } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // #16: Structured console logging
    console.error("[ErrorBoundary]", {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  private handleCopyError = async () => {
    const { error } = this.state;
    if (error) {
      const text = `${error.message}\n\n${error.stack ?? ""}`;
      await navigator.clipboard.writeText(text);
    }
  };

  private handleRetry = () => {
    // #16: Reset active session to prevent re-crash loops
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {this.props.fallbackMessage ?? "Something went wrong"}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm mt-1">
              {this.state.error?.message}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={this.handleCopyError}>
              <Copy className="mr-1.5 h-3 w-3" />
              Copy Error
            </Button>
            <Button variant="outline" size="sm" onClick={this.handleRetry}>
              <RefreshCw className="mr-1.5 h-3 w-3" />
              Retry
            </Button>
            <Button variant="outline" size="sm" onClick={this.handleReload}>
              <RotateCcw className="mr-1.5 h-3 w-3" />
              Reload Page
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
