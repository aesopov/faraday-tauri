import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { bridge } from './bridge';

export function TerminalPanel({ cwd }: { cwd: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: 'var(--bg)' === 'var(--bg)' ? '#1e1e2e' : undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Spawn PTY
    bridge.pty.spawn(cwdRef.current).then((id) => {
      ptyIdRef.current = id;

      term.onData((data) => {
        bridge.pty.write(id, data);
      });

      term.onResize(({ cols, rows }) => {
        bridge.pty.resize(id, cols, rows);
      });

      // Send initial size
      bridge.pty.resize(id, term.cols, term.rows);
    });

    // Receive PTY output
    const cleanupData = bridge.pty.onData((id, data) => {
      if (id === ptyIdRef.current) {
        term.write(data);
      }
    });

    const cleanupExit = bridge.pty.onExit((id) => {
      if (id === ptyIdRef.current) {
        term.write('\r\n[Process exited]\r\n');
        ptyIdRef.current = null;
      }
    });

    // Fit on resize
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    return () => {
      ro.disconnect();
      cleanupData();
      cleanupExit();
      if (ptyIdRef.current !== null) {
        bridge.pty.close(ptyIdRef.current);
      }
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-container" />;
}
