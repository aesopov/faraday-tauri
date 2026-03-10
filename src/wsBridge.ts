/// Browser-side bridge over WebSocket — connects to the faraday-server headless backend.
///
/// Implements the same Bridge interface as tauriBridge.ts, using JSON-RPC 2.0
/// over WebSocket. Binary frames are used for fs.read responses.
import type { Bridge } from './bridge';
import type { FsaRawEntry, FsChangeEvent, FsChangeType } from './types';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const BINARY_HEADER_SIZE = 4; // uint32 LE requestId prefix on binary frames

export async function createWsBridge(wsUrl: string): Promise<Bridge> {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const changeListeners = new Set<(event: FsChangeEvent) => void>();

  const connected = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    });
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      handleText(event.data);
    } else {
      handleBinary(event.data as ArrayBuffer);
    }
  });

  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) {
      reject(new Error('WebSocket closed'));
    }
    pending.clear();
  });

  function handleText(text: string): void {
    const msg = JSON.parse(text);

    // JSON-RPC notification (watch event)
    if (!('id' in msg) && msg.method === 'fs.change') {
      const event: FsChangeEvent = {
        watchId: msg.params.watchId as string,
        type: msg.params.type as FsChangeType,
        name: (msg.params.name as string) ?? null,
      };
      for (const cb of changeListeners) cb(event);
      return;
    }

    // JSON-RPC response
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as Error & { code?: string }).code = msg.error.data?.errno;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  function handleBinary(data: ArrayBuffer): void {
    const view = new DataView(data);
    const requestId = view.getUint32(0, true);
    const payload = data.slice(BINARY_HEADER_SIZE);

    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    p.resolve(payload);
  }

  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return connected.then(
      () =>
        new Promise((resolve, reject) => {
          if (ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket is not connected'));
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        }),
    );
  }

  await connected;

  return {
    fsa: {
      entries: (dirPath: string) =>
        rpc('fs.entries', { path: dirPath }) as Promise<FsaRawEntry[]>,
      stat: (filePath: string) =>
        rpc('fs.stat', { path: filePath }) as Promise<{ size: number; mtimeMs: number }>,
      exists: (filePath: string) => rpc('fs.exists', { path: filePath }) as Promise<boolean>,
      open: (filePath: string) => rpc('fs.open', { path: filePath }) as Promise<number>,
      read: (fd: number, offset: number, length: number) =>
        rpc('fs.read', { handle: fd, offset, length }) as Promise<ArrayBuffer>,
      close: (fd: number) => rpc('fs.close', { handle: fd }) as Promise<void>,
      watch: (watchId: string, dirPath: string) =>
        rpc('fs.watch', { watchId, path: dirPath }) as Promise<boolean>,
      unwatch: (watchId: string) => rpc('fs.unwatch', { watchId }) as Promise<void>,
      onFsChange(callback: (event: FsChangeEvent) => void): () => void {
        changeListeners.add(callback);
        return () => {
          changeListeners.delete(callback);
        };
      },
    },
    utils: {
      getHomePath: () => rpc('utils.getHomePath', {}) as Promise<string>,
      getIconsPath: () => rpc('utils.getIconsPath', {}) as Promise<string>,
    },
    theme: {
      get: () =>
        Promise.resolve(
          window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        ),
      onChange(callback: (theme: string) => void): () => void {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e: MediaQueryListEvent) =>
          callback(e.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      },
    },
  };
}
