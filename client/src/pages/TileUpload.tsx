import { useState, useRef, useCallback } from "react";
import { Upload, CheckCircle, XCircle, Loader2, Image, Trash2, Info } from "lucide-react";

const API_BASE = "/trpc";

interface UploadResult {
  filename: string;
  status: "success" | "error" | "processing";
  message?: string;
  labAvg?: [number, number, number];
}

async function uploadTileImage(file: File): Promise<UploadResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = (e.target?.result as string).split(",")[1];
      try {
        const res = await fetch(`${API_BASE}/uploadTileImage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: { imageBase64: base64, filename: file.name } }),
        });
        const data = await res.json();
        if (data.result?.data) {
          resolve({ filename: file.name, status: "success", labAvg: data.result.data.labAvg });
        } else {
          resolve({ filename: file.name, status: "error", message: data.error?.message ?? "Upload fehlgeschlagen" });
        }
      } catch (err) {
        resolve({ filename: file.name, status: "error", message: String(err) });
      }
    };
    reader.readAsDataURL(file);
  });
}

export default function TileUpload() {
  const [results, setResults] = useState<UploadResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    setUploading(true);
    const pending: UploadResult[] = imageFiles.map(f => ({ filename: f.name, status: "processing" as const }));
    setResults(prev => [...pending, ...prev]);

    const BATCH = 3;
    for (let i = 0; i < imageFiles.length; i += BATCH) {
      const batch = imageFiles.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(f => uploadTileImage(f)));
      setResults(prev => {
        const updated = [...prev];
        batchResults.forEach((res, j) => {
          const idx = updated.findIndex(r => r.filename === imageFiles[i + j].name && r.status === "processing");
          if (idx >= 0) updated[idx] = res;
        });
        return updated;
      });
    }
    setUploading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  }, [processFiles]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    processFiles(files);
    e.target.value = "";
  }, [processFiles]);

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const processingCount = results.filter(r => r.status === "processing").length;

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "32px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: "#111827", margin: 0 }}>Eigene Tile-Bibliothek</h1>
        <p style={{ color: "#6b7280", marginTop: 8 }}>
          Lade deine eigenen Fotos hoch – sie werden als Kacheln im Mosaik verwendet.
          Für jedes Bild werden automatisch LAB-Farben berechnet und im Feature-Index gespeichert.
        </p>
      </div>

      {/* Info Box */}
      <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, marginBottom: 24, display: "flex", gap: 12 }}>
        <Info size={20} style={{ color: "#2563eb", flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, color: "#1e40af" }}>
          <strong>Wie es funktioniert:</strong> Jedes hochgeladene Bild wird auf 64×64 px skaliert, LAB-Farben werden berechnet
          und in der Datenbank gespeichert. Das Studio verwendet dann diese Bilder bevorzugt beim Mosaik-Matching.
          Unterstützte Formate: JPG, PNG, WEBP, HEIC.
        </div>
      </div>

      {/* Drop Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "#7c3aed" : "#d1d5db"}`,
          borderRadius: 16,
          padding: "48px 24px",
          textAlign: "center",
          cursor: "pointer",
          background: dragOver ? "#f5f3ff" : "#fafafa",
          transition: "all 0.2s",
          marginBottom: 24,
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileChange}
          style={{ display: "none" }}
        />
        <Upload size={40} style={{ color: dragOver ? "#7c3aed" : "#9ca3af", marginBottom: 12 }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: "#374151", marginBottom: 4 }}>
          Fotos hier ablegen oder klicken zum Auswählen
        </div>
        <div style={{ fontSize: 13, color: "#9ca3af" }}>
          Mehrere Bilder gleichzeitig möglich · JPG, PNG, WEBP, HEIC
        </div>
      </div>

      {/* Stats */}
      {results.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
          {successCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#16a34a", fontWeight: 600 }}>
              <CheckCircle size={16} /> {successCount} erfolgreich
            </div>
          )}
          {processingCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#d97706", fontWeight: 600 }}>
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> {processingCount} wird verarbeitet
            </div>
          )}
          {errorCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
              <XCircle size={16} /> {errorCount} Fehler
            </div>
          )}
          <button
            onClick={() => setResults([])}
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9ca3af", background: "none", border: "none", cursor: "pointer" }}
          >
            <Trash2 size={14} /> Liste leeren
          </button>
        </div>
      )}

      {/* Results List */}
      {results.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
          {results.map((r, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
              borderBottom: i < results.length - 1 ? "1px solid #f3f4f6" : "none",
              background: i % 2 === 0 ? "#fff" : "#fafafa",
            }}>
              {r.status === "processing" && <Loader2 size={18} style={{ color: "#d97706", animation: "spin 1s linear infinite", flexShrink: 0 }} />}
              {r.status === "success" && <CheckCircle size={18} style={{ color: "#16a34a", flexShrink: 0 }} />}
              {r.status === "error" && <XCircle size={18} style={{ color: "#dc2626", flexShrink: 0 }} />}

              <Image size={16} style={{ color: "#9ca3af", flexShrink: 0 }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.filename}
                </div>
                {r.status === "error" && r.message && (
                  <div style={{ fontSize: 11, color: "#dc2626", marginTop: 2 }}>{r.message}</div>
                )}
                {r.status === "success" && r.labAvg && (
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                    LAB: ({r.labAvg[0].toFixed(0)}, {r.labAvg[1].toFixed(0)}, {r.labAvg[2].toFixed(0)})
                  </div>
                )}
              </div>

              <div style={{ fontSize: 12, color: r.status === "success" ? "#16a34a" : r.status === "error" ? "#dc2626" : "#d97706", fontWeight: 600 }}>
                {r.status === "processing" ? "Verarbeitung..." : r.status === "success" ? "Gespeichert" : "Fehler"}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Note about server endpoint */}
      <div style={{ marginTop: 32, padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, marginBottom: 6 }}>Hinweis</div>
        <div style={{ fontSize: 13, color: "#374151" }}>
          Der Upload-Endpoint <code style={{ background: "#e5e7eb", padding: "1px 4px", borderRadius: 3 }}>/api/trpc/uploadTileImage</code> muss
          auf dem Server aktiviert sein. Wende dich an den Administrator, falls Uploads fehlschlagen.
        </div>
      </div>
    </div>
  );
}
