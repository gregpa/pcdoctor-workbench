import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ConfirmModal } from '../components/layout/ConfirmModal.js';

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  tier: 'risky' | 'destructive';
  confirmLabel?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm: ConfirmFn = useCallback((opts) => {
    return new Promise((resolve) => setState({ ...opts, resolve }));
  }, []);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {state && (
        <ConfirmModal
          title={state.title}
          body={state.body}
          tier={state.tier}
          confirmLabel={state.confirmLabel}
          onConfirm={() => { state.resolve(true); setState(null); }}
          onCancel={() => { state.resolve(false); setState(null); }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}
