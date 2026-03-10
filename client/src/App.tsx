import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Component, type ReactNode } from "react";
import { Navbar } from "./components/Navbar";
import { Footer } from "./components/Footer";
import Landing from "./pages/Landing";
import Studio from "./pages/Studio";
import Pricing from "./pages/Pricing";
import HowItWorks from "./pages/HowItWorks";
import Admin from "./pages/Admin";
import TileUpload from "./pages/TileUpload";

// Error boundary to prevent white screen crashes
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb' }}>
          <div style={{ maxWidth: 400, background: 'white', borderRadius: 16, padding: 32, textAlign: 'center', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Seite konnte nicht geladen werden</h2>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 16 }}>{this.state.error}</p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#E8735A', color: 'white', fontWeight: 600, padding: '8px 24px', borderRadius: 12, border: 'none', cursor: 'pointer' }}
            >
              Seite neu laden
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-white">
        <Navbar />
        <main className="flex-1">
          <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/preise" element={<Pricing />} />
            <Route path="/so-funktionierts" element={<HowItWorks />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/tile-upload" element={<TileUpload />} />
            <Route path="*" element={<Landing />} />
          </Routes>
          </ErrorBoundary>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
