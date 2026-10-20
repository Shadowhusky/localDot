// Existing readers are terminated when a link expires or is revoked, including video/NDJSON.
export function revocableResponse(
  response: Response,
  valid: () => boolean,
  subscribe: (end: () => void) => () => void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let ended = false;
  let unsubscribe = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribe(() => {
        if (ended) return;
        ended = true;
        unsubscribe();
        void reader.cancel().catch(() => {});
        controller.error(new Error("Shared access ended"));
      });
    },
    async pull(controller) {
      if (ended) return;
      if (!valid()) {
        ended = true;
        unsubscribe();
        void reader.cancel().catch(() => {});
        controller.error(new Error("Shared access ended"));
        return;
      }
      try {
        const chunk = await reader.read();
        if (ended) return;
        if (!valid()) throw new Error("Shared access ended");
        if (chunk.done) {
          ended = true;
          unsubscribe();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        if (!ended) {
          ended = true;
          unsubscribe();
          controller.error(error);
        }
      }
    },
    async cancel() {
      ended = true;
      unsubscribe();
      await reader.cancel();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
