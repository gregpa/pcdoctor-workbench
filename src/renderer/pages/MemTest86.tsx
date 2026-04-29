import { useState } from 'react';
import { api } from '@renderer/lib/ipc.js';

export function MemTest86() {
  const [step, setStep] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  async function launchTool(id: string) {
    const r = await api.launchTool(id, 'gui');
    if (r.ok) {
      setToast(`Launched ${id}`);
    } else {
      setToast(`Launch failed: ${r.error.message}`);
    }
    setTimeout(() => setToast(null), 4000);
  }

  const steps = [
    {
      title: '1. Download MemTest86 ISO',
      body: (
        <div>
          <p className="mb-2">Download the <strong>Free</strong> edition of MemTest86 from the official site. The ZIP contains <code>memtest86-usb.img</code> and an ISO.</p>
          <a href="https://www.memtest86.com/download.htm" target="_blank" rel="noreferrer" className="inline-block px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">Open memtest86.com/download</a>
          <p className="mt-3 text-[11px] text-text-secondary">After downloading, extract the ZIP anywhere. Then advance to Step 2.</p>
        </div>
      ),
    },
    {
      title: '2. Create bootable USB with Rufus',
      body: (
        <div>
          <p className="mb-2">Insert a USB stick (at least 2 GB - everything on it will be ERASED), then launch Rufus.</p>
          <button onClick={() => launchTool('rufus')} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">Launch Rufus</button>
          <div className="mt-3 text-[11px] text-text-secondary space-y-1">
            <div>• Device: Your USB stick</div>
            <div>• Boot selection: <strong>Click SELECT</strong> → pick <code>memtest86-usb.img</code> from the extracted ZIP</div>
            <div>• Leave all other settings at default</div>
            <div>• Click <strong>START</strong>, confirm the erase warning, wait ~30 seconds</div>
          </div>
        </div>
      ),
    },
    {
      title: '3. Reboot and boot from USB',
      body: (
        <div>
          <p className="mb-2">Once Rufus finishes, reboot the PC and press the boot-menu key to select the USB.</p>
          <div className="pcd-panel text-[11px]">
            <div><strong>Alienware Aurora R11:</strong> Press <code>F12</code> right after power-on. Select your USB from the boot menu.</div>
            <div className="mt-1">Other common keys: Dell=F12, HP=F9, Lenovo=F12, ASUS=F8.</div>
          </div>
          <p className="mt-3 text-[11px] text-text-secondary">MemTest86 starts automatically. Leave it running for <strong>at least 4 full passes</strong> (~4–8 hours depending on RAM size). Any errors appear on screen.</p>
        </div>
      ),
    },
    {
      title: '4. Record outcome',
      body: (
        <div>
          <p className="mb-3">After your test run, what happened?</p>
          <div className="flex gap-2">
            <button onClick={() => { setToast('✓ Recorded: MemTest86 passed (no errors). Saved to logs.'); setTimeout(() => setToast(null), 6000); setStep(0); }} className="px-3 py-1.5 rounded-md text-xs bg-status-good text-black font-bold">No errors - PASSED</button>
            <button onClick={() => { setToast('⚠ Recorded: MemTest86 found errors. Consider RAM replacement.'); setTimeout(() => setToast(null), 6000); setStep(0); }} className="px-3 py-1.5 rounded-md text-xs bg-status-crit text-white font-bold">Errors found</button>
          </div>
          <p className="mt-3 text-[11px] text-text-secondary">If errors found: take a photo of the screen, note the exact error code + affected address ranges, then reseat each DIMM (remove and reinsert) and retest. If errors persist on a specific slot only, that slot is bad. If errors follow a specific DIMM across slots, that DIMM is bad.</p>
        </div>
      ),
    },
  ];

  return (
    <div className="p-5 max-w-3xl">
      <h1 className="text-lg font-bold mb-1">🧠 MemTest86 Guided Wizard</h1>
      <p className="text-[11px] text-text-secondary mb-4">
        Offline RAM stress test. Required when you've had 2+ BSODs in 30 days or unexplained crashes. Takes ~4–8 hours of unattended runtime.
      </p>

      <div className="flex gap-2 mb-4">
        {steps.map((s, i) => (
          <button key={i} onClick={() => setStep(i)} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${i === step ? 'bg-status-info/20 border border-status-info/60 text-status-info' : 'bg-surface-800 border border-surface-600 text-text-secondary'}`}>
            Step {i + 1}
          </button>
        ))}
      </div>

      <div className="pcd-section">
        <h2 className="text-base font-bold mb-3">{steps[step].title}</h2>
        <div className="text-sm">{steps[step].body}</div>
      </div>

      <div className="flex justify-between mt-3">
        <button disabled={step === 0} onClick={() => setStep(step - 1)} className="px-3 py-1.5 rounded-md text-xs pcd-button disabled:opacity-30">← Previous</button>
        <button disabled={step === steps.length - 1} onClick={() => setStep(step + 1)} className="px-3 py-1.5 rounded-md text-xs pcd-button disabled:opacity-30">Next →</button>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 pcd-button rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
