import { HashRouter, Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';
import { History } from './pages/History.js';
import { Settings } from './pages/Settings.js';
import { Forecast } from './pages/Forecast.js';
import { WeeklyReview } from './pages/WeeklyReview.js';
import { Security } from './pages/Security.js';
import { Tools } from './pages/Tools.js';
import { Updates } from './pages/Updates.js';
import { MemTest86 } from './pages/MemTest86.js';
import { Claude } from './pages/Claude.js';
import { Autopilot } from './pages/Autopilot.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ClaudeApprovalListener } from './components/layout/ClaudeApprovalListener.js';
import { FirstRunWizard } from './components/layout/FirstRunWizard.js';
import { ConfirmProvider } from './lib/confirmContext.js';
import './styles/globals.css';

export function App() {
  return (
    <ConfirmProvider>
      <FirstRunWizard />
      <ClaudeApprovalListener />
      <HashRouter>
        {/* v2.4.24: outer container is fixed to viewport height + hides
          * overflow so the Sidebar stays pinned regardless of main-area
          * scroll. Previously min-h-screen let the whole div grow with
          * page content, making the document-level scroll bar take over
          * and carry the sidebar off-screen. */}
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/history" element={<History />} />
              <Route path="/forecast" element={<Forecast />} />
              <Route path="/weekly-review" element={<WeeklyReview />} />
              <Route path="/security" element={<Security />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/updates" element={<Updates />} />
              <Route path="/memtest86" element={<MemTest86 />} />
              <Route path="/claude" element={<Claude />} />
              <Route path="/autopilot" element={<Autopilot />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </ConfirmProvider>
  );
}
