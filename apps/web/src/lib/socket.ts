export interface SocketHandlers {
  onMessage(data: string): void;
  onOpen?(): void;
  onClose?(): void;
}

export interface SocketOptions {
  url: string;
  protocols: string[];
  handlers: SocketHandlers;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: { min: number; max: number };
}

export interface SocketHandle {
  close(): void;
}

// Reconnects with doubling backoff until close(). The daemon selects localdot.v1 and never the
// localdot.token.<t> entry, which only rides along for authentication.
export function openSocket(opts: SocketOptions): SocketHandle {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const backoff = opts.backoffMs ?? { min: 500, max: 5000 };
  let delay = backoff.min;
  let closed = false;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    ws = new Impl(opts.url, opts.protocols);
    ws.onopen = () => {
      delay = backoff.min;
      opts.handlers.onOpen?.();
    };
    ws.onmessage = (e) => opts.handlers.onMessage(String(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null;
      opts.handlers.onClose?.();
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(backoff.max, delay * 2);
    };
  };
  connect();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
