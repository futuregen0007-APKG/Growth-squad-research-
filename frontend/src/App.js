import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import Layout from "@/components/layout/Layout";
import Dashboard from "@/pages/Dashboard";
import Watchlist from "@/pages/Watchlist";
import SectorIntelligence from "@/pages/SectorIntelligence";
import EarningsIntelligence from "@/pages/EarningsIntelligence";
import AIResearch from "@/pages/AIResearch";
import StockDetail from "@/pages/StockDetail";

function App() {
  return (
    <div className="App min-h-screen bg-gs-bg text-gs-text">
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/sectors" element={<SectorIntelligence />} />
            <Route path="/earnings" element={<EarningsIntelligence />} />
            <Route path="/ai-research" element={<AIResearch />} />
            <Route path="/stock/:ticker" element={<StockDetail />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#0C0E12",
            border: "1px solid #1E222A",
            color: "#F8FAFC",
            borderRadius: "4px",
            fontFamily: "IBM Plex Sans, sans-serif",
          },
        }}
      />
    </div>
  );
}

export default App;
