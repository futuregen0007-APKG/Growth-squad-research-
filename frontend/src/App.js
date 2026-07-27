import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import Layout from "@/components/layout/Layout";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import { AuthProvider } from "@/hooks/useAuth";
import Watchlist from "@/pages/Watchlist";
import SectorIntelligence from "@/pages/SectorIntelligence";
import EarningsIntelligence from "@/pages/EarningsIntelligence";
import AIResearch from "@/pages/AIResearch";
import StockDetail from "@/pages/StockDetail";
import SearchResults from "@/pages/SearchResults";
import Portfolio from "@/pages/Portfolio";
import Settings from "@/pages/Settings";
import News from "@/pages/News";
import FinancialOnboarding from "@/pages/FinancialOnboarding";
import Goals from "@/pages/Goals";
import InvestmentBaskets from "@/pages/InvestmentBaskets";
import SIPPlanner from "@/pages/SIPPlanner";
import RetirementPlanner from "@/pages/RetirementPlanner";
import NetWorth from "@/pages/NetWorth";

function App() {
  return (
    <div className="App min-h-screen bg-gs-bg text-gs-text">
      <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/onboarding" element={<FinancialOnboarding />} />
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/baskets" element={<InvestmentBaskets />} />
            <Route path="/sip-planner" element={<SIPPlanner />} />
            <Route path="/retirement" element={<RetirementPlanner />} />
            <Route path="/net-worth" element={<NetWorth />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/news" element={<News />} />
            <Route path="/sectors" element={<SectorIntelligence />} />
            <Route path="/earnings" element={<EarningsIntelligence />} />
            <Route path="/ai-research" element={<AIResearch />} />
            <Route path="/stock/:ticker" element={<StockDetail />} />
            <Route path="/search" element={<SearchResults />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </AuthProvider>
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
