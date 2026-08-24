import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

/**
 * Modelled on echos_app `components/auth/error-boundary.tsx`: a Card with a
 * destructive title, the error message, and Try again / Reload. Nothing is
 * reported anywhere — this instance has no telemetry, so the message goes to
 * the operator's own console and screen and nowhere else.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Admin panel render failed", error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-svh items-center justify-center bg-sidebar p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlertIcon className="size-5" />
              The panel could not render this
            </CardTitle>
            <CardDescription>
              A bug in the panel, not a refusal from the store. Nothing was
              written.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <pre className="datum-scroll max-h-48 overflow-auto rounded-md border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
              {error.message}
            </pre>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={this.reset} variant="outline">
                <RefreshCwIcon />
                Try again
              </Button>
              <Button
                className="flex-1"
                onClick={() => window.location.reload()}
                variant="primary"
              >
                Reload
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
