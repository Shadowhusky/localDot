import { clsx } from "clsx";
import { Component, Fragment, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { Icon } from "./Icon.tsx";

export interface ErrorBoundaryProps {
  children: ReactNode;
  // Over the page rather than in the part's place: for a part that floats, such as a sheet.
  floating?: boolean;
  className?: string;
  // A part the page can do without, such as dot: it leaves no card and draws itself again later.
  quiet?: boolean;
}

const QUIET_RETRY_MS = 5000;

interface State {
  failed: boolean;
  // Each reload draws the part afresh.
  attempt: number;
}

// Keeps a part of the page that fails from taking the rest with it: the part gives way to a calm
// card that brings it back. React reports the error to the console.
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  #retry: ReturnType<typeof setTimeout> | undefined;

  reload = () => this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));

  componentDidCatch() {
    if (!this.props.quiet) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(this.reload, QUIET_RETRY_MS);
  }

  componentWillUnmount() {
    clearTimeout(this.#retry);
  }

  render() {
    if (!this.state.failed)
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    if (this.props.quiet) return null;
    return (
      <div
        className={clsx("ui-part-failed", this.props.className)}
        data-floating={this.props.floating || undefined}
      >
        <Card className="ui-part-failed-card" role="status">
          <Icon name="circle-alert" size={16} className="ui-part-failed-icon" />
          <p className="ui-part-failed-title">Something went wrong here</p>
          <Button size="sm" onClick={this.reload}>
            Reload this part
          </Button>
        </Card>
      </div>
    );
  }
}
