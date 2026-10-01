export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface SocketHandlers {
  text(data: string): void;
  binary(data: Uint8Array): void;
  status?(online: boolean): void;
}

export const PROTOCOL = "localdot.v1";
export const RETRY_MS = [500, 1000, 2000, 4000, 8000];
const OPEN = 1;

const browserSocket: SocketFactory = (url, protocols) => new WebSocket(url, protocols);

// A WebSocket that reconnects with backoff until closed; the voice routes speak JSON and binary.
export class VoiceSocket {
  readonly #url: string;
  readonly #handlers: SocketHandlers;
  readonly #create: SocketFactory;
  readonly #protocols: string[];
  #socket: SocketLike | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = true;

  constructor(
    url: string,
    handlers: SocketHandlers,
    options: { create?: SocketFactory; token?: string } = {},
  ) {
    this.#url = url;
    this.#handlers = handlers;
    this.#create = options.create ?? browserSocket;
    this.#protocols = options.token ? [PROTOCOL, `localdot.token.${options.token}`] : [PROTOCOL];
  }

  get open(): boolean {
    return this.#socket?.readyState === OPEN;
  }

  connect(): void {
    this.#closed = false;
    if (this.#socket) return;
    const socket = this.#create(this.#url, this.#protocols);
    // A replaced socket can still report its close late; only the current one speaks for us.
    const current = () => this.#socket === socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (!current()) return;
      this.#attempt = 0;
      this.#handlers.status?.(true);
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      if (typeof event.data === "string") this.#handlers.text(event.data);
      else if (event.data instanceof ArrayBuffer) this.#handlers.binary(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      if (!current()) return;
      this.#socket = null;
      this.#handlers.status?.(false);
      if (this.#closed) return;
      const delay = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)] ?? 8000;
      this.#attempt++;
      this.#timer = setTimeout(() => this.connect(), delay);
    };
    this.#socket = socket;
  }

  send(data: string | Uint8Array<ArrayBuffer>): boolean {
    if (!this.open || !this.#socket) return false;
    this.#socket.send(data);
    return true;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.close();
    this.#handlers.status?.(false);
  }
}
