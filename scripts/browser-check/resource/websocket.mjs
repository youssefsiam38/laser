function once(socket, event, listener) {
  if (typeof socket.once === 'function') {
    socket.once(event, listener);
    return () => socket.off?.(event, listener);
  }
  socket.addEventListener(event, listener, { once: true });
  return () => socket.removeEventListener?.(event, listener);
}

function listen(socket, event, listener) {
  if (typeof socket.on === 'function') {
    socket.on(event, listener);
    return () => socket.off?.(event, listener);
  }
  socket.addEventListener(event, listener);
  return () => socket.removeEventListener?.(event, listener);
}

/** Close one Node WebSocket and settle only after its close event. */
export async function closeNodeWebSocket(socket, { force = false, resume = false, timeoutMs = 2_000 } = {}) {
  if (resume) socket._socket?.resume?.();
  if (socket.readyState === 3) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let forced = force;
    const cleanupClose = once(socket, 'close', () => finish());
    const cleanupError = once(socket, 'error', () => {});
    const hardTimer = setTimeout(() => {
      if (!forced && typeof socket.terminate === 'function') {
        forced = true;
        socket.terminate();
        return;
      }
      finish(new Error('WebSocket did not close within its bounded teardown window.'));
    }, timeoutMs);
    const finalTimer = setTimeout(() => finish(new Error('WebSocket forced teardown did not emit close.')), timeoutMs * 2);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(finalTimer);
      cleanupClose();
      cleanupError();
      error ? reject(error) : resolve();
    }
    try {
      if (force && typeof socket.terminate === 'function') socket.terminate();
      else if (socket.readyState < 2) socket.close();
      else if (socket.readyState === 2 && typeof socket.terminate === 'function') socket.terminate();
    } catch (error) {
      if (typeof socket.terminate === 'function') {
        forced = true;
        try { socket.terminate(); } catch {}
      } else finish(error);
    }
  });
}

/** One request per product socket; even a response is not delivered until close settles. */
export async function settledWebSocketRpc({ WebSocketCtor, url, request, timeoutMs }) {
  const socket = new WebSocketCtor(url);
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      let settled = false;
      const cleanupOpen = once(socket, 'open', () => {
        try { socket.send(JSON.stringify(request)); } catch (error) { finish(error); }
      });
      const cleanupMessage = listen(socket, 'message', event => {
        try {
          const raw = event?.data ?? event;
          const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (message.id !== request.id) return;
          finish(undefined, message);
        } catch (error) { finish(error); }
      });
      const cleanupError = once(socket, 'error', error => finish(error instanceof Error ? error : new Error('RPC WebSocket failed.')));
      const cleanupClose = once(socket, 'close', () => finish(new Error(`RPC ${request.method} WebSocket closed before its response.`)));
      const timer = setTimeout(() => finish(new Error(`RPC ${request.method} timed out.`)), timeoutMs);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupOpen(); cleanupMessage(); cleanupError(); cleanupClose();
        error ? reject(error) : resolve(value);
      }
    });
  } catch (error) {
    await closeNodeWebSocket(socket, { force: true, resume: true });
    throw error;
  }
  await closeNodeWebSocket(socket, { resume: true });
  if (response.error) throw new Error(`${request.method}: ${response.error.message}`);
  return response.result;
}
