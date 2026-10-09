export interface SocketHandlers {
  onMessage(data: string): void;
  onOpen?(): void;
  onClose?(): void;
  // A socket closed before it ever opened. The daemon refuses an upgrade before the handshake (a
  // revoked token's 403, an unknown cell's 404), and the browser reports only a close (1006), so
  // the owner has to ask the daemon why. It also follows a connection the daemon never answered.
  onRefused?(): void;
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
  // Sends on the open connection; false while there is none. Nothing is queued.
  send(data: string): boolean;
}

// Reconnects with doubling backoff until close(). The daemon selects localdot.v1 and never the
// localdot.token.<t> entry, which only rides along for authentication.
export function openSocket(opts: SocketOptions): SocketHandle {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const backoff = opts.backoffMs ?? { min: 500, max: 5000 };
  let delay = backoff.min;
  let closed = false;
  let ws: WebSocket | null = null;
  let live: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    let opened = false;
    const socket = new Impl(opts.url, opts.protocols);
    ws = socket;
    ws.onopen = () => {
      opened = true;
      live = socket;
      delay = backoff.min;
      opts.handlers.onOpen?.();
    };
    ws.onmessage = (e) => opts.handlers.onMessage(String(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null;
      live = null;
      opts.handlers.onClose?.();
      if (closed) return;
      if (!opened) opts.handlers.onRefused?.();
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
    send(data) {
      if (!live) return false;
      live.send(data);
      return true;
    },
  };
}
