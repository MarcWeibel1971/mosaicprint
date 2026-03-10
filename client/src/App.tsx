import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { Footer } from "./components/Footer";
import Landing from "./pages/Landing";
import Studio from "./pages/Studio";
import Pricing from "./pages/Pricing";
import HowItWorks from "./pages/HowItWorks";
import Admin from "./pages/Admin";
import TileUpload from "./pages/TileUpload";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-white">
        <Navbar />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/preise" element={<Pricing />} />
            <Route path="/so-funktionierts" element={<HowItWorks />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/tile-upload" element={<TileUpload />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
