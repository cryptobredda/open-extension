/** Streaming SSE parser: chunk boundaries, CRLF, UTF-8 and multiline data are all handled. */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ data: string; id?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [],
    eventId: string | undefined;
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield { data: data.join('\n'), id: eventId };
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('id:')) eventId = line.slice(3).replace(/^ /, '');
        if (buffer.length > 4_000_000 || data.join('').length > 4_000_000)
          throw new Error('Server event exceeds the size limit.');
      }
      if (buffer.length > 4_000_000) throw new Error('Server event exceeds the size limit.');
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
