import { HashRouter, Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';
import { History } from './pages/History.js';
import { Settings } from './pages/Settings.js';
import { Forecast } from './pages/Forecast.js';
import { WeeklyReview } from './pages/WeeklyReview.js';
import { Security } from './pages/Security.js';
import { Tools } from './pages/Tools.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ConfirmProvider } from './lib/confirmContext.js';
import './styles/globals.css';

export function App() {
  return (
    <ConfirmProvider>
      <HashRouter>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/history" element={<History />} />
              <Route path="/forecast" element={<Forecast />} />
              <Route path="/weekly-review" element={<WeeklyReview />} />
              <Route path="/security" element={<Security />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </ConfirmProvider>
  );
}
