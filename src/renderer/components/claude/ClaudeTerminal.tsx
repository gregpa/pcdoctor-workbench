import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface ClaudeTerminalProps {
  contextText?: string;
  onExit?: () => void;
}

export function ClaudeTerminal({ contextText, onExit }: ClaudeTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [sessionId] = useState(() => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
      fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    const api = (window as any).api;

    term.onData((d) => { api.claudePty.write(sessionId, d); });

    const dataUnsub = api.claudePty.onData(sessionId, (chunk: string) => { term.write(chunk); });
    const exitUnsub = api.claudePty.onExit(sessionId, ({ exitCode }: any) => {
      term.writeln(`\r\n\n[Claude session exited with code ${exitCode}]`);
      setStatus('exited');
      onExit?.();
    });

    (async () => {
      const r = await api.claudePty.spawn({ id: sessionId, contextText, cols: term.cols, rows: term.rows });
      if (r.ok) setStatus('running');
      else { setStatus('error'); setErrorMsg(r.error ?? 'Failed to start'); }
    })();

    const onResize = () => {
      if (!termRef.current) return;
      fit.fit();
      api.claudePty.resize(sessionId, termRef.current.cols, termRef.current.rows);
    };
    window.addEventListener('resize', onResize);

    return () => {
      dataUnsub();
      exitUnsub();
      api.claudePty.kill(sessionId);
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, [sessionId, contextText]);

  return (
    <div className="flex flex-col h-full">
      {status === 'error' && (
        <div className="p-3 bg-status-crit/10 border border-status-crit/40 text-status-crit text-xs">
          Terminal failed to start: {errorMsg}
        </div>
      )}
      {status === 'exited' && (
        <div className="p-2 bg-surface-700 border-b border-surface-600 text-[11px] text-text-secondary">
          Session ended. Refresh the page to start a new one.
        </div>
      )}
      <div ref={containerRef} className="flex-1 bg-surface-900 overflow-hidden" style={{ minHeight: 400 }} />
    </div>
  );
}
