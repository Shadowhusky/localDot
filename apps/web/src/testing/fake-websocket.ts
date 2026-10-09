// Stands in for the browser's WebSocket and keeps every socket it creates, so a test can play the
// daemon's side: open it, deliver a message with onmessage, or drop the connection.
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  readonly sent: string[] = [];
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
