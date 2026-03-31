import React, { useState, useEffect, useCallback, useRef } from 'react'
import { rgbToLab as rgbToLabUtil } from '../lib/colorUtils'
import { useAuth } from '../contexts/AuthContext'
// jsPDF loaded dynamically to avoid chunk initialization errors at module load time
import {
  Database, RefreshCw, Upload, Image as ImageIcon, Save, CheckCircle, XCircle,
  Zap, Camera, Settings, Grid, BarChart2, Filter, ChevronLeft, ChevronRight, Trash2, X, Download, FileText, AlertTriangle,
  Users, Link, Plus, QrCode
} from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Upgrade a tile URL to a higher-resolution preview URL */
function getHighResUrl(url: string, size = 600, tile128Url?: string, tileId?: number): string {
  if (!url) return url
  // Picsum: https://picsum.photos/id/123/128/128 -> /id/123/600/600
  const picsumMatch = url.match(/picsum\.photos\/id\/([^/]+)\/\d+\/\d+/)
  if (picsumMatch) return `https://picsum.photos/id/${picsumMatch[1]}/${size}/${size}`
  // Unsplash: use tile128Url as base (it has proper query params) and replace w=
  if (url.includes('images.unsplash.com')) {
    // sourceUrl often has broken format like 'photo-xxx&q=80' without '?'
    // Use tile128Url as base if available, otherwise try to fix sourceUrl
    const base = tile128Url && tile128Url.includes('unsplash.com') ? tile128Url : url
    if (base.includes('?')) {
      return base.replace(/[&?]w=\d+/g, '').replace(/[&?]h=\d+/g, '') + `&w=${size}`
    }
    // sourceUrl without proper query string - extract photo ID and build clean URL
    const photoMatch = (url + tile128Url).match(/photo-([a-zA-Z0-9_-]+)/)
    if (photoMatch) return `https://images.unsplash.com/photo-${photoMatch[1]}?w=${size}&q=80&auto=format&fit=crop`
    return url
  }
  // Pexels: replace or add w= and h= params for higher resolution
  if (url.includes('images.pexels.com')) {
    const base = url.replace(/[&?]w=\d+/g, '').replace(/[&?]h=\d+/g, '')
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}w=${size}&h=${size}&fit=crop`
  }
  // CloudFront / S3 tile URLs: use tile128Url directly (already a working image)
  if (url.includes('cloudfront.net') || url.includes('amazonaws.com')) {
    return url
  }
  // Fallback: use server-side tile proxy for unknown sources (lhq, pixabay, etc.)
  // The /api/tile/:id endpoint resizes from source_url via sharp
  if (tileId && tileId > 0) return `/api/tile/${tileId}?size=${size}`
  return url
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface DbStats { total: number; labIndexed: number; notIndexed: number }
interface ApiKeyStatus { stripe: boolean; unsplash: boolean; pexels: boolean; pixabay: boolean }
interface ImportJob {
  running: boolean; imported?: number; total?: number
  log: string[]; error?: string | null; finishedAt?: string | null
  sessionId?: string | null
}
interface ImportPreviewTile {
  id: number; tile128_url: string; r2_url: string | null; source_url: string
  avg_l: number; avg_a: number; avg_b: number
  subject: string; import_query: string; source_provider: string
}
interface TileImage {
  id: number; sourceUrl: string; tile128Url: string
  avgL: number; avgA: number; avgB: number
  // Quadrant LAB values (15D matching features)
  tlL?: number; tlA?: number; tlB?: number
  trL?: number; trA?: number; trB?: number
  blL?: number; blA?: number; blB?: number
  brL?: number; brA?: number; brB?: number
  createdAt: string; sourceId: string
  colorCategory: string | null; brightnessCategory: string | null
  subject: string | null
  qualityStatus?: string | null
  tileType?: string | null
  photographerName?: string | null
  photographerUrl?: string | null
  // Quality metrics
  aiMosaicScore?: number | null   // 0-100 Gesamteignung
  edgeEnergy?: number | null      // 0-1 Kantendichte (Sobel)
  blurScore?: number | null       // Laplacian Variance (< 100 = unscharf)
  geminiScore?: number | null     // 0-1 Gemini-Qualitätsbewertung
  geminiStatus?: string | null    // pending | approved | rejected
  saturationCategory?: string | null // niedrig | mittel | hoch
  warmCoolCategory?: string | null   // warm | kuehl | neutral
  importQuery?: string | null
}
interface DbStatsDetail {
  total: number; labIndexed: number
  bySource: Record<string, number>
  byColor: Record<string, number>
  byBrightness: Record<string, number>
  byWarmCool?: Record<string, number>
  byBrightness5?: Record<string, number>
  bySaturation?: Record<string, number>
  grayCount?: number
  bySubject?: Record<string, number>
  byTileType?: Record<string, number>
}
interface CronStatus {
  enabled: boolean; current: number; target: number; remaining: number; intervalHours: number
  cronRunning?: boolean; lastCronRun?: string | null; lastCronResult?: string | null
}
interface SmartImportJob {
  running: boolean; imported?: number; total?: number
  log: string[]; error?: string | null; finishedAt?: string | null
}

// ── Last image analysis result (persisted via localStorage for cross-tab use) ──
interface LastAnalysisData {
  keywords: Array<{keyword: string; reason: string; priority: string}>
  sceneType: string
  timestamp: string
}
interface ImportRecommendation { query: string; label: string; priority: number; deficit: number; subject: string }

// ── Algorithm settings stored in localStorage ─────────────────────────────────
const SETTINGS_KEY = 'mosaicprint_algo_settings'
const OVERRIDES_KEY = 'mosaicprint_algo_overrides'  // manual Admin overrides, applied on top of presets
interface AlgoSettings {
  baseTiles: number
  tilePx: number
  baseOverlay: number
  edgeBoost: number
  neighborRadius: number
  neighborPenalty: number
  hiResPx: number
  hiResThreshold: number
  labWeight: number
  brightnessWeight: number
  textureWeight: number
  edgeWeight: number
  enableRotation: boolean
  histogramBlend: number   // 0-0.3: LAB Color Transfer strength (0=off, 0.1=65%, 0.15=100%)
  contrastBoost: number    // 1.0-1.5: contrast boost on target before matching
  overlayMode: 'none' | 'softlight' | 'alpha'  // overlay blending mode
  mobileMaxTiles: number  // max unique tiles loaded on mobile (default 1500)
  blurOpacity: number      // blur-overlay opacity 0–0.30 (default 0.08 = 8%)
}
// ── Preset Profiles ──────────────────────────────────────────────────────────
interface Profile {
  id: string
  label: string
  icon: string
  description: string
  settings: Partial<AlgoSettings>
}
const PRESET_PROFILES: Profile[] = [
  {
    id: 'portrait',
    label: 'Portrait',
    icon: '👤',
    description: 'Optimiert für Gesichter: feineres Raster, Haut-Ton-Boost, Soft-Overlay, keine Rotation.',
    settings: {
      baseTiles: 120, tilePx: 8, baseOverlay: 0.20, edgeBoost: 0.0,
      brightnessWeight: 0.45, labWeight: 0.30, textureWeight: 0.12, edgeWeight: 0.13,
      contrastBoost: 1.28, histogramBlend: 0.08, overlayMode: 'softlight', enableRotation: false,
      neighborRadius: 6, neighborPenalty: 400,
    }
  },
  {
    id: 'landscape',
    label: 'Landschaft',
    icon: '🏔️',
    description: 'Optimiert für Landschaften: breites Raster, starke Farb-Gewichtung, hoher Farb-Transfer.',
    settings: {
      baseTiles: 80, tilePx: 10, baseOverlay: 0.0, edgeBoost: 0.0,
      brightnessWeight: 0.28, labWeight: 0.40, textureWeight: 0.20, edgeWeight: 0.12,
      contrastBoost: 1.45, histogramBlend: 0.12, overlayMode: 'none', enableRotation: true,
      neighborRadius: 8, neighborPenalty: 150,
    }
  },
  {
    id: 'night',
    label: 'Nacht / Skyline',
    icon: '🏃',
    description: 'Optimiert für dunkle Szenen: starker Kontrast, Textur/Kanten erhöht, Soft-Overlay.',
    settings: {
      baseTiles: 90, tilePx: 9, baseOverlay: 0.05, edgeBoost: 0.15,
      brightnessWeight: 0.35, labWeight: 0.25, textureWeight: 0.30, edgeWeight: 0.10,
      contrastBoost: 1.65, histogramBlend: 0.05, overlayMode: 'softlight', enableRotation: true,
      neighborRadius: 6, neighborPenalty: 200,
    }
  },
  {
    id: 'colorful',
    label: 'Farbenreich',
    icon: '🎨',
    description: 'Maximale Farbvielfalt: starker Farb-Transfer, hohe Sättigungs-Gewichtung, kräftiger Kontrast.',
    settings: {
      baseTiles: 100, tilePx: 8, baseOverlay: 0.0, edgeBoost: 0.0,
      brightnessWeight: 0.25, labWeight: 0.45, textureWeight: 0.15, edgeWeight: 0.15,
      contrastBoost: 1.40, histogramBlend: 0.13, overlayMode: 'none', enableRotation: true,
      neighborRadius: 6, neighborPenalty: 200,
    }
  },
  {
    id: 'highres',
    label: 'Hochauflösend',
    icon: '🔬',
    description: 'Maximale Detailschärfe: sehr feines Raster, minimale Überlagerung, keine Rotation.',
    settings: {
      baseTiles: 150, tilePx: 6, baseOverlay: 0.0, edgeBoost: 0.0,
      brightnessWeight: 0.45, labWeight: 0.25, textureWeight: 0.15, edgeWeight: 0.15,
      contrastBoost: 1.15, histogramBlend: 0.05, overlayMode: 'none', enableRotation: false,
      neighborRadius: 4, neighborPenalty: 310,
    }
  },
  // ── Neue Profile (4 zusätzliche) ────────────────────────────────────────────────────────────
  {
    id: 'portrait_dark',
    label: 'Portrait dunkel',
    icon: '🧑🏿',
    description: 'Dunklere Hautöne (Afro-/asiatische Typen): höhere Helligkeit, starke LAB-Farbe, weicher Kontrast.',
    settings: {
      baseTiles: 120, tilePx: 8, baseOverlay: 0.18, edgeBoost: 0.0,
      brightnessWeight: 0.45, labWeight: 0.35, textureWeight: 0.10, edgeWeight: 0.10,
      contrastBoost: 1.15, histogramBlend: 0.09, overlayMode: 'softlight', enableRotation: false,
      neighborRadius: 5, neighborPenalty: 220,
    }
  },
  {
    id: 'white_hair',
    label: 'Weiße Haare/Bart',
    icon: '👴',
    description: 'Ältere Personen, silbernes Haar: hohe Helligkeit, sehr strenge Anti-Repetition, Soft-Overlay.',
    settings: {
      baseTiles: 120, tilePx: 8, baseOverlay: 0.20, edgeBoost: 0.0,
      brightnessWeight: 0.60, labWeight: 0.30, textureWeight: 0.05, edgeWeight: 0.05,
      contrastBoost: 1.20, histogramBlend: 0.07, overlayMode: 'softlight', enableRotation: false,
      neighborRadius: 6, neighborPenalty: 350,
    }
  },
  {
    id: 'minimal',
    label: 'Minimalistisch',
    icon: '⬜',
    description: 'Clean, wenig Details, viel Weißraum: feines Raster, starke LAB-Farbe, kein Overlay, keine Rotation.',
    settings: {
      baseTiles: 140, tilePx: 7, baseOverlay: 0.0, edgeBoost: 0.0,
      brightnessWeight: 0.35, labWeight: 0.40, textureWeight: 0.15, edgeWeight: 0.10,
      contrastBoost: 1.10, histogramBlend: 0.06, overlayMode: 'none', enableRotation: false,
      neighborRadius: 5, neighborPenalty: 200,
    }
  },
  {
    id: 'abstract_art',
    label: 'Abstrakt / Kunst',
    icon: '🖼️',
    description: 'Gemälde-ähnliche oder sehr bunte Motive: maximaler Farb-Transfer, hohe Sättigung, kräftiger Kontrast.',
    settings: {
      baseTiles: 100, tilePx: 9, baseOverlay: 0.0, edgeBoost: 0.0,
      brightnessWeight: 0.20, labWeight: 0.50, textureWeight: 0.15, edgeWeight: 0.15,
      contrastBoost: 1.40, histogramBlend: 0.13, overlayMode: 'none', enableRotation: true,
      neighborRadius: 5, neighborPenalty: 180,
    }
  },
]

const DEFAULT_SETTINGS: AlgoSettings = {
  baseTiles: 100,     // 100 columns = fine detail (matches reference quality)
  tilePx: 8,          // 8px display tiles = fine detail
  baseOverlay: 0.0,   // NO overlay – pure tile rendering like reference
  edgeBoost: 0.0,     // No edge overlay
  neighborRadius: 6,
  neighborPenalty: 200,
  hiResPx: 200,
  hiResThreshold: 1.2,
  labWeight: 0.15,
  brightnessWeight: 0.50,  // brightness drives face structure (luminance = face shape)
  textureWeight: 0.15,
  edgeWeight: 0.20,
  enableRotation: true,
  histogramBlend: 0.0,     // NO color transfer – tiles keep natural colors
  contrastBoost: 1.20,     // Mild contrast boost for matching
  overlayMode: 'none' as const,  // Pure tile rendering
  mobileMaxTiles: 1500,  // max unique tiles on mobile (higher = better quality, more RAM)
  blurOpacity: 0.08,      // blur-overlay opacity (8% = subtle edge softening)
}

function loadSettings(): AlgoSettings {
  try {
    const s = localStorage.getItem(SETTINGS_KEY)
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : { ...DEFAULT_SETTINGS }
  } catch { return { ...DEFAULT_SETTINGS } }
}
function saveSettings(s: AlgoSettings) {
  // Save to SETTINGS_KEY for Admin panel state persistence
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  // Save as overrides so Studio preset-merge respects manual Admin changes.
  // NOTE: Studio's renderMosaic reads SETTINGS_KEY directly, but portrait-critical
  // parameters (tilePx, enableRotation) are enforced at render time regardless.
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(s))
}

// ── Color helpers ─────────────────────────────────────────────────────────────
const COLOR_LABELS: Record<string, { label: string; color: string; emoji: string }> = {
  rot:     { label: 'Rot',     color: '#ef4444', emoji: '🔴' },
  orange:  { label: 'Orange',  color: '#f97316', emoji: '🟠' },
  gelb:    { label: 'Gelb',    color: '#eab308', emoji: '🟡' },
  gruen:   { label: 'Grün',    color: '#22c55e', emoji: '🟢' },
  cyan:    { label: 'Cyan',    color: '#06b6d4', emoji: '🩵' },
  blau:    { label: 'Blau',    color: '#3b82f6', emoji: '🔵' },
  violett: { label: 'Violett', color: '#a855f7', emoji: '🟣' },
  pink:    { label: 'Pink',    color: '#ec4899', emoji: '🩷' },
  grau:    { label: 'Grau',    color: '#6b7280', emoji: '⚫' },
  weiss:   { label: 'Weiss',   color: '#d1d5db', emoji: '⬜' },
  schwarz: { label: 'Schwarz', color: '#1f2937', emoji: '⬛' },
}

// ── Quality Assurance Types & Constants (declared before all components to avoid TDZ) ──
interface QaRun {
  id: number; checkType: string; status: string; startedAt: string; finishedAt: string | null; summary: Record<string, unknown> | null
}
interface QaItem {
  id: number; runId: number; entityType: string; entityId: string; status: string; message: string; details: Record<string, unknown> | null
}
const QA_CHECKS = [
  { id: 'index-integrity', label: 'Index-Integrität', icon: '🔍', desc: 'Prüft ob alle Bilder LAB-Werte haben und Quadrant-Index vollständig ist.' },
  { id: 'pool-balance', label: 'Pool-Balance', icon: '⚖️', desc: 'Analysiert Farbraum-Abdeckung: Dunkel/Hell/Sättigung/Warm/Kühl.' },
  { id: 'import-health', label: 'Import-Health', icon: '📥', desc: 'Zeigt Import-Statistiken pro Quelle und prüft auf URL-Duplikate.' },
  { id: 'duplicate-check', label: 'Duplikat-Check', icon: '🔁', desc: 'Sucht nach pHash- und URL-Duplikaten in der Datenbank.' },
  { id: 'tile-quality-score', label: 'Tile-Quality-Score', icon: '⭐', desc: 'Bewertet 200 zufällige Tiles nach Farbvielfalt, Textur und Helligkeit.' },
]

// ── R2 Migration Panel ──────────────────────────────────────────────────────────
interface R2Status {
  running: boolean; done: number; total: number; errors: number;
  skippedHotlink?: number; skippedNoUrl?: number; retried?: number;
  startedAt: string | null; finishedAt: string | null; lastError?: string;
}
interface R2Diagnosis {
  ok: boolean;
  stats: { total: string; on_r2: string; pixabay_hotlink: string; no_url: string; migratable: string; missing_r2: string };
  byProvider: Array<{ source_provider: string; total: string; on_r2: string; missing: string }>;
}
function R2MigrationPanel() {
  const { authHeaders } = useAuth();
  const [status, setStatus] = React.useState<R2Status | null>(null);
  const [diagnosis, setDiagnosis] = React.useState<R2Diagnosis | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingDiag, setLoadingDiag] = React.useState(false);

  const fetchStatus = async () => {
    try {
      const r = await fetch('/api/admin/migrate-to-r2/status', { headers: authHeaders() });
      const d = await r.json();
      setStatus(d);
    } catch { /* ignore */ }
  };

  const fetchDiagnosis = async () => {
    setLoadingDiag(true);
    try {
      const r = await fetch('/api/admin/r2-diagnosis', { headers: authHeaders() });
      const d = await r.json();
      setDiagnosis(d);
    } catch { /* ignore */ } finally { setLoadingDiag(false); }
  };

  React.useEffect(() => {
    fetchStatus();
    fetchDiagnosis();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const startMigration = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/migrate-to-r2', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (d.error) alert('Fehler: ' + d.error);
      else fetchStatus();
    } catch (e) { alert('Fehler: ' + e); }
    setLoading(false);
  };

  const progress = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  const isDone = status && !status.running && status.finishedAt;

  return (
    <div className="bg-white rounded-2xl p-6 border border-orange-200">
      <h2 className="font-bold text-gray-900 mb-2 flex items-center gap-2">
        <span className="text-orange-500">☁️</span>
        Cloudflare R2 – Permanente Bildspeicherung
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Lädt alle Tile-Bilder zu Cloudflare R2 hoch damit sie dauerhaft verfügbar sind (Pixabay/Unsplash CDN-URLs können ablaufen).
      </p>

      {/* Diagnose-Statistik */}
      {diagnosis?.ok && (
        <div className="mb-4 bg-gray-50 rounded-xl p-4 border border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider">R2-Status Diagnose</h4>
            <button onClick={fetchDiagnosis} disabled={loadingDiag} className="text-xs text-blue-600 hover:underline">{loadingDiag ? 'Lade...' : '↺ Aktualisieren'}</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            <div className="bg-green-50 rounded-lg p-2 text-center">
              <div className="font-bold text-green-700 text-base">{Number(diagnosis.stats.on_r2).toLocaleString('de-CH')}</div>
              <div className="text-green-600">✅ Auf R2</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-2 text-center">
              <div className="font-bold text-amber-700 text-base">{Number(diagnosis.stats.pixabay_hotlink).toLocaleString('de-CH')}</div>
              <div className="text-amber-600">🔒 Pixabay-Hotlinks</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-2 text-center">
              <div className="font-bold text-blue-700 text-base">{Number(diagnosis.stats.migratable).toLocaleString('de-CH')}</div>
              <div className="text-blue-600">⏳ Noch migrierbar</div>
            </div>
            <div className="bg-red-50 rounded-lg p-2 text-center">
              <div className="font-bold text-red-700 text-base">{Number(diagnosis.stats.missing_r2).toLocaleString('de-CH')}</div>
              <div className="text-red-600">❌ Fehlt R2</div>
            </div>
            <div className="bg-gray-100 rounded-lg p-2 text-center">
              <div className="font-bold text-gray-700 text-base">{Number(diagnosis.stats.no_url).toLocaleString('de-CH')}</div>
              <div className="text-gray-500">Keine URL</div>
            </div>
            <div className="bg-gray-100 rounded-lg p-2 text-center">
              <div className="font-bold text-gray-700 text-base">{Number(diagnosis.stats.total).toLocaleString('de-CH')}</div>
              <div className="text-gray-500">Total Tiles</div>
            </div>
          </div>
          {diagnosis.byProvider.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-gray-500 mb-1">Nach Quelle:</p>
              <div className="space-y-1">
                {diagnosis.byProvider.map(p => (
                  <div key={p.source_provider ?? 'unknown'} className="flex items-center gap-2 text-xs">
                    <span className="w-20 text-gray-600 truncate">{p.source_provider ?? '(unbekannt)'}</span>
                    <div className="flex-1 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                      <div className="h-1.5 bg-green-400 rounded-full" style={{ width: `${Number(p.total) > 0 ? Math.round(Number(p.on_r2)/Number(p.total)*100) : 0}%` }} />
                    </div>
                    <span className="text-green-600 w-8 text-right">{Number(p.total) > 0 ? Math.round(Number(p.on_r2)/Number(p.total)*100) : 0}%</span>
                    <span className="text-gray-400 w-20 text-right">{Number(p.on_r2).toLocaleString('de-CH')}/{Number(p.total).toLocaleString('de-CH')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {Number(diagnosis.stats.pixabay_hotlink) > 0 && (
            <p className="text-xs text-amber-700 mt-2 bg-amber-50 rounded-lg p-2">
              ⚠️ <strong>{Number(diagnosis.stats.pixabay_hotlink).toLocaleString('de-CH')} Pixabay-Tiles</strong> können nicht zu R2 migriert werden (Hotlink-Schutz).
              Diese Tiles sollten mit „Kaputte Pixabay-Tiles löschen“ bereinigt und neu importiert werden.
            </p>
          )}
        </div>
      )}

      {status && status.total > 0 && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{status.done.toLocaleString('de-CH')} / {status.total.toLocaleString('de-CH')} verarbeitet</span>
            <span>{progress}%
              {status.errors > 0 && <span className="text-red-500 ml-1">· {status.errors} Fehler</span>}
              {(status.skippedHotlink ?? 0) > 0 && <span className="text-amber-500 ml-1">· {status.skippedHotlink} Hotlinks übersprungen</span>}
              {(status.retried ?? 0) > 0 && <span className="text-blue-500 ml-1">· {status.retried} Retries</span>}
            </span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${isDone ? 'bg-green-400' : 'bg-orange-400'}`} style={{ width: `${progress}%` }} />
          </div>
          {isDone && <p className="text-xs text-green-600 mt-1">✅ Migration abgeschlossen</p>}
          {status.running && <p className="text-xs text-orange-600 mt-1">⏳ Migration läuft... (läuft im Hintergrund)</p>}
          {status.lastError && <p className="text-xs text-red-500 mt-1 truncate">⚠️ Letzter Fehler: {status.lastError}</p>}
        </div>
      )}
      <button
        onClick={startMigration}
        disabled={loading || (status?.running ?? false)}
        className="px-4 py-2 bg-orange-500 text-white rounded-xl text-sm font-medium hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status?.running ? '⏳ Migration läuft...' : isDone ? '✅ Erneut migrieren (neue Tiles)' : '🚀 Migration starten (alle Tiles zu R2)'}
      </button>

      <Tile256Backfill />
    </div>
  );
}

function Tile256Backfill() {
  const { authHeaders } = useAuth();
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; total?: number; done?: number; errors?: number; message?: string; error?: string } | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/admin/backfill-tile256', {
        method: 'POST',
        headers: authHeaders(),
      });
      const d = await r.json();
      setResult(d);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-orange-100">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">LHQ Tile256 Backfill</h3>
      <p className="text-xs text-gray-500 mb-3">
        Erstellt 256px-Versionen aller LHQ-Tiles (aus tile128 oder R2) und lädt sie auf R2 hoch. Verbessert die Vorschau- und Druckqualität.
      </p>
      <button
        onClick={run}
        disabled={running}
        className="px-4 py-2 bg-blue-500 text-white rounded-xl text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? '⏳ Backfill läuft...' : '🔧 Tile256 Backfill starten'}
      </button>
      {result && (
        <div className={`mt-3 p-3 rounded-xl text-sm ${result.ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {result.message || result.error}
          {result.ok && result.errors !== undefined && result.errors > 0 && (
            <div className="text-xs text-amber-600 mt-1">{result.errors} Fehler aufgetreten</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Keyword Generator ──────────────────────────────────────────────────────────
// Generates ready-to-use import keywords for calm/monochrome/extreme tiles
function KeywordGenerator({ onInsertKeywords }: { onInsertKeywords: (kws: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [activeCategory, setActiveCategory] = useState<'calm' | 'extreme_dark' | 'extreme_bright' | null>(null)
  const [selectedColor, setSelectedColor] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // ── Keyword tables ──────────────────────────────────────────────────────────
  const CALM_MONO_BY_COLOR: Record<string, { label: string; emoji: string; keywords: string[] }> = {
    white:   { label: 'Weiss/Hell', emoji: '⬜', keywords: ['plain white wall minimal', 'white paper background clean', 'cream white background minimal', 'off white texture smooth', 'white mist fog minimal', 'bright white abstract', 'white studio background', 'white fabric smooth', 'white bokeh bright'] },
    gray:    { label: 'Grau', emoji: '🩶', keywords: ['light gray wall smooth', 'gray concrete smooth minimal', 'pale gray sky overcast', 'silver gray smooth abstract', 'pale neutral background', 'dark gray smooth abstract', 'charcoal gray smooth minimal', 'dark slate background clean', 'deep charcoal minimal'] },
    black:   { label: 'Schwarz/Dunkel', emoji: '⬛', keywords: ['dark navy blue smooth', 'black smooth gradient', 'very dark gray minimal', 'black gradient smooth', 'deep charcoal minimal', 'dark blue smooth background', 'dark slate background clean'] },
    blue:    { label: 'Blau', emoji: '🔵', keywords: ['clear blue sky minimal', 'smooth blue gradient abstract', 'pale blue background minimal', 'deep blue ocean smooth', 'navy blue smooth gradient', 'soft blue abstract smooth', 'blue gradient minimal', 'cornflower blue smooth', 'blue sky cloudless'] },
    green:   { label: 'Grün', emoji: '🟢', keywords: ['dark green smooth bokeh', 'forest green abstract blur', 'olive green smooth minimal', 'soft green bokeh background', 'deep green smooth gradient', 'sage green minimal', 'muted green abstract smooth', 'dark olive smooth', 'forest bokeh green blur'] },
    red:     { label: 'Rot/Burgund', emoji: '🔴', keywords: ['dark burgundy smooth minimal', 'deep red smooth gradient', 'muted red abstract smooth', 'wine red minimal', 'dark maroon smooth', 'soft red gradient abstract'] },
    orange:  { label: 'Orange/Braun', emoji: '🟠', keywords: ['warm beige smooth background', 'tan brown minimal smooth', 'warm brown gradient', 'camel beige smooth abstract', 'warm taupe minimal', 'light brown smooth', 'warm sand minimal background', 'khaki smooth abstract'] },
    yellow:  { label: 'Gelb/Gold', emoji: '🟡', keywords: ['golden hour sky smooth', 'warm sand dunes minimal', 'pale yellow abstract smooth', 'light golden gradient', 'soft yellow bokeh', 'cream yellow background minimal'] },
    purple:  { label: 'Lila/Violett', emoji: '🟣', keywords: ['dark purple smooth minimal', 'deep violet smooth gradient', 'muted purple abstract', 'soft lavender background', 'violet gradient smooth', 'dark plum minimal'] },
    cyan:    { label: 'Türkis/Teal', emoji: '🩵', keywords: ['teal smooth gradient minimal', 'dark teal abstract smooth', 'muted teal minimal', 'soft cyan smooth background', 'dark teal smooth', 'muted turquoise minimal'] },
    pink:    { label: 'Rosa/Pink', emoji: '🩷', keywords: ['blush pink neutral background', 'soft pink gradient minimal', 'pale rose abstract smooth', 'muted pink background', 'dusty rose fabric', 'light pink bokeh soft'] },
    brown:   { label: 'Braun/Erde', emoji: '🟤', keywords: ['warm earth texture smooth', 'brown soil minimal', 'dark wood smooth', 'warm bark texture', 'coffee brown abstract', 'terracotta smooth minimal'] },
  }

  const EXTREME_DARK_KEYWORDS = [
    'pure black background', 'black velvet texture', 'dark night sky stars', 'black coal texture',
    'black ink abstract', 'dark shadow minimal', 'black marble texture', 'night photography dark',
    'black fur closeup', 'dark forest night', 'black metal texture', 'very dark abstract',
    'black leather texture', 'dark void abstract', 'black stone texture', 'deep shadow portrait',
    'dark navy background', 'midnight black abstract', 'dark charcoal texture', 'black gradient smooth',
  ]

  const EXTREME_BRIGHT_KEYWORDS = [
    'pure white background', 'bright white snow', 'overexposed white light', 'white marble texture',
    'bright white clouds', 'white foam ocean', 'white paper texture bright', 'white flower macro bright',
    'bright sunlight reflection', 'white sand beach bright', 'white fabric bright', 'white wall bright',
    'bright white abstract', 'white bokeh bright', 'overexposed portrait', 'white studio background',
    'light leak bright', 'white mist fog', 'bright sky overexposed', 'snow field bright white',
  ]

  const getKeywords = (): string[] => {
    if (activeCategory === 'calm' && selectedColor) {
      return CALM_MONO_BY_COLOR[selectedColor]?.keywords ?? []
    }
    if (activeCategory === 'extreme_dark') return EXTREME_DARK_KEYWORDS
    if (activeCategory === 'extreme_bright') return EXTREME_BRIGHT_KEYWORDS
    return []
  }

  const keywords = getKeywords()

  const handleCopy = () => {
    navigator.clipboard.writeText(keywords.join(', '))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleInsert = () => {
    if (keywords.length > 0) onInsertKeywords(keywords.join(', '))
  }

  return (
    <div className="mb-4 p-4 bg-violet-50 rounded-xl border border-violet-200">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-sm font-semibold text-violet-900">✨ Keyword-Generator</span>
        <span className="text-xs text-violet-600">Generiert optimale Keywords für ruhige, monochrome, extrem helle und dunkle Tiles</span>
        <span className="ml-auto text-violet-400">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Category selector */}
          <div className="flex gap-2 flex-wrap">
            {([
              { id: 'calm', label: '🌫️ Ruhige Monochrome', desc: 'Pro Farbe' },
              { id: 'extreme_dark', label: '⬛ Extrem Dunkel', desc: 'avg_L < 10' },
              { id: 'extreme_bright', label: '⬜ Extrem Hell', desc: 'avg_L > 85' },
            ] as const).map(cat => (
              <button
                key={cat.id}
                onClick={() => { setActiveCategory(cat.id); setSelectedColor(null) }}
                className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-violet-600 text-white border-violet-600'
                    : 'bg-white text-violet-700 border-violet-300 hover:bg-violet-100'
                }`}
              >
                {cat.label} <span className="opacity-70">({cat.desc})</span>
              </button>
            ))}
          </div>

          {/* Color picker for calm category */}
          {activeCategory === 'calm' && (
            <div>
              <div className="text-xs text-violet-700 font-medium mb-2">Farbe wählen:</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(CALM_MONO_BY_COLOR).map(([key, val]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedColor(key)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      selectedColor === key
                        ? 'bg-violet-600 text-white border-violet-600'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-violet-50'
                    }`}
                  >
                    <span>{val.emoji}</span> {val.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Generated keywords preview */}
          {keywords.length > 0 && (
            <div className="bg-white rounded-lg border border-violet-200 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-violet-800">{keywords.length} Keywords generiert:</span>
                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
                  >
                    {copied ? '✅ Kopiert!' : '📋 Kopieren'}
                  </button>
                  <button
                    onClick={handleInsert}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white transition-colors"
                  >
                    ↓ In Import einfügen
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {keywords.map((kw, i) => (
                  <span key={i} className="inline-block bg-violet-100 text-violet-800 rounded px-2 py-0.5 text-xs">{kw}</span>
                ))}
              </div>
            </div>
          )}

          {/* Quick-generate all calm colors */}
          {activeCategory === 'calm' && (
            <button
              onClick={() => {
                const all = Object.values(CALM_MONO_BY_COLOR).flatMap(v => v.keywords)
                onInsertKeywords(all.join(', '))
              }}
              className="w-full py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
            >
              🎨 Alle Farben auf einmal einfügen ({Object.values(CALM_MONO_BY_COLOR).reduce((s, v) => s + v.keywords.length, 0)} Keywords)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────────
export default function Admin() {
  const { authHeaders } = useAuth();
  // Mark admin as visited in localStorage so Studio shows admin-only buttons
  useEffect(() => {
    try { localStorage.setItem('mosaicprint_admin_visited', '1'); } catch {}
  }, []);
  const [activeTab, setActiveTab] = useState<'database' | 'import' | 'algorithm' | 'quality' | 'orders'>('database')
  const [stats, setStats] = useState<DbStats | null>(null)
  const [apiKeys, setApiKeys] = useState<ApiKeyStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [activeJob, setActiveJob] = useState<string | null>(null)
  const [activeJobs, setActiveJobs] = useState<Set<string>>(new Set())
  const [importProgress, setImportProgress] = useState<Record<string, ImportJob>>({})
  const [smartJob, setSmartJob] = useState<SmartImportJob | null>(null)
  const [smartSource, setSmartSource] = useState<'unsplash' | 'pexels' | 'pixabay'>('pexels')
  const [importAllBatch, setImportAllBatch] = useState(500)
  const [importAllRunning, setImportAllRunning] = useState(false)
  const [importCategory, setImportCategory] = useState<string>('')  // selected category for targeted import
  // Freie Keyword-Eingabe
  const [customKeywords, setCustomKeywords] = useState<string>('')  // comma-separated keywords
  const [customKeywordSource, setCustomKeywordSource] = useState<'pexels' | 'unsplash' | 'pixabay'>('pixabay')
  const [customKeywordCount, setCustomKeywordCount] = useState(100)
  const [customKeywordLoading, setCustomKeywordLoading] = useState(false)
  const [customKeywordResult, setCustomKeywordResult] = useState<string>('')
  const [customKeywordPreview, setCustomKeywordPreview] = useState<Array<{query: string; count: number; status: string}>>([])
  // Gezielte Importe (Empfehlungen)
  const [recommendations, setRecommendations] = useState<ImportRecommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [recsJobs, setRecsJobs] = useState<Record<string, SmartImportJob>>({})
  const [recsRunning, setRecsRunning] = useState(false)
  const [selectedRecs, setSelectedRecs] = useState<Set<string>>(new Set())
  // Import-Review-Modal
  const [importReviewOpen, setImportReviewOpen] = useState(false)
  const [importReviewSessionId, setImportReviewSessionId] = useState<string | null>(null)
  const [importReviewTiles, setImportReviewTiles] = useState<ImportPreviewTile[]>([])
  const [importReviewRejected, setImportReviewRejected] = useState<Set<number>>(new Set())
  const [importReviewLoading, setImportReviewLoading] = useState(false)
  const [importReviewConfirming, setImportReviewConfirming] = useState(false)
  // Last image analysis result (from Quality tab) - persisted via localStorage for cross-tab use
  const [lastAnalysis, setLastAnalysis] = useState<LastAnalysisData | null>(() => {
    try { const s = localStorage.getItem('mosaicprint_last_analysis'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [analysisImportJobMain, setAnalysisImportJobMain] = useState<SmartImportJob | null>(null)
  const [analysisImportRunningMain, setAnalysisImportRunningMain] = useState(false)
  const [analysisImportSourceMain, setAnalysisImportSourceMain] = useState<'pexels' | 'unsplash' | 'pixabay'>('pexels')
  const [recsExpanded, setRecsExpanded] = useState(false)
  // Excellent Keyword Import
  const [excellentKeywords, setExcellentKeywords] = useState<Array<{keyword: string; count: number; avgScore: number; avgChroma: number}>>([])
  const [excellentTotal, setExcellentTotal] = useState(0)
  const [excellentLoading, setExcellentLoading] = useState(false)
  const [excellentSelected, setExcellentSelected] = useState<Set<string>>(new Set())
  const [excellentImportSource, setExcellentImportSource] = useState<'pexels' | 'unsplash' | 'pixabay' | 'flickr'>('flickr')
  const [excellentImportCount, setExcellentImportCount] = useState(50)
  const [excellentImportJob, setExcellentImportJob] = useState<SmartImportJob | null>(null)
  const [excellentImportRunning, setExcellentImportRunning] = useState(false)
  // Mirror Tiles
  const [mirrorBatch, setMirrorBatch] = useState(500)
  const [mirrorResult, setMirrorResult] = useState<string>('')
  // Rebuild/Reclassify Job Status (for progress bar)
  const [rebuildStatus, setRebuildStatus] = useState<{ running: boolean; log: string[]; startedAt: string | null; finishedAt: string | null; error: string | null } | null>(null)
  const rebuildPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // fetchStats declared here (before startRebuildPolling) to avoid TDZ
  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const [statsRes, keysRes] = await Promise.all([
        fetch('/api/trpc/getTileStats', { headers: authHeaders() }),
        fetch('/api/trpc/getApiKeyStatus', { headers: authHeaders() }),
      ])
      const statsData = await statsRes.json()
      const keysData = await keysRes.json()
      setStats(statsData.result?.data?.json ?? statsData.result?.data ?? statsData)
      setApiKeys(keysData.result?.data?.json ?? keysData.result?.data ?? keysData)
    } catch {
      setMessage({ text: 'Fehler beim Laden der Statistiken', type: 'error' })
    } finally { setLoading(false) }
  }, [authHeaders])

  const startRebuildPolling = useCallback(() => {
    if (rebuildPollRef.current) return
    rebuildPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/trpc/getRebuildStatus', { headers: authHeaders() })
        const data = await res.json()
        const status = data.result?.data ?? data
        setRebuildStatus(status)
        if (!status?.running) {
          clearInterval(rebuildPollRef.current!)
          rebuildPollRef.current = null
          fetchStats()
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [fetchStats])

  const startSmartImport = async (sourceId: 'unsplash' | 'pexels' | 'pixabay') => {
    if (activeJob) return
    setActiveJob(`smart_${sourceId}`)
    setSmartJob({ running: true, log: [], imported: 0, total: 0 })
    setMessage({ text: `Smart-Import von ${sourceId} gestartet...`, type: 'info' })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId, batchPerColor: 30 }),
      })
    } catch {
      setActiveJob(null)
      setMessage({ text: 'Fehler beim Starten des Smart-Imports', type: 'error' })
    }
  }

  const fetchRecommendations = useCallback(async () => {
    setRecsLoading(true)
    try {
      const params = encodeURIComponent(JSON.stringify({ limit: 30 }))
      const res = await fetch(`/api/trpc/getImportRecommendations?input=${params}`, { headers: authHeaders() })
      const data = await res.json()
      const result = data.result?.data ?? data
      setRecommendations(result.tasks ?? [])
      // Select only Top 5 by deficit (largest gap first) by default
      const top5 = [...(result.tasks ?? [])]
        .sort((a: { deficit: number }, b: { deficit: number }) => b.deficit - a.deficit)
        .slice(0, 5)
        .map((t: { query: string }) => t.query);
      setSelectedRecs(new Set(top5))
    } catch { /* ignore */ } finally {
      setRecsLoading(false)
    }
  }, [authHeaders])

  // Open Import-Review-Modal for a given session
  const openImportReview = useCallback(async (sessionId: string) => {
    setImportReviewSessionId(sessionId)
    setImportReviewRejected(new Set())
    setImportReviewLoading(true)
    setImportReviewOpen(true)
    try {
      const params = encodeURIComponent(JSON.stringify({ sessionId }))
      const res = await fetch(`/api/trpc/getImportPreview?input=${params}`, { headers: authHeaders() })
      const data = await res.json()
      const tiles: ImportPreviewTile[] = data.result?.data?.tiles ?? data.result?.data?.json?.tiles ?? []
      setImportReviewTiles(tiles)
    } catch {
      setMessage({ text: 'Fehler beim Laden der Import-Vorschau', type: 'error' })
      setImportReviewOpen(false)
    } finally {
      setImportReviewLoading(false)
    }
  }, [authHeaders])
  // Confirm Import: activate selected, delete rejected
  const confirmImportReview = useCallback(async () => {
    if (!importReviewSessionId) return
    setImportReviewConfirming(true)
    try {
      const rejectedIds = Array.from(importReviewRejected)
      const res = await fetch('/api/trpc/confirmImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId: importReviewSessionId, rejectedIds }),
      })
      const data = await res.json()
      const result = data.result?.data ?? data
      setMessage({ text: `✅ ${result.activated ?? 0} Tiles aktiviert, ${result.deleted ?? 0} gelöscht`, type: 'success' })
      setImportReviewOpen(false)
      setImportReviewTiles([])
      setImportReviewSessionId(null)
      fetchStats()
    } catch {
      setMessage({ text: 'Fehler beim Bestätigen des Imports', type: 'error' })
    } finally {
      setImportReviewConfirming(false)
    }
  }, [importReviewSessionId, importReviewRejected, fetchStats])

  // Start analysis-based import from Import tab (uses lastAnalysis from localStorage)
  const startAnalysisImportMain = useCallback(async () => {
    if (!lastAnalysis || analysisImportRunningMain) return
    const keywords = lastAnalysis.keywords
    if (!keywords || keywords.length === 0) return
    const kwStrings = keywords.map((kw: { keyword: string }) => kw.keyword)
    const totalEstimate = kwStrings.length * 30
    setAnalysisImportRunningMain(true)
    setAnalysisImportJobMain({ running: true, log: [`🚀 Starte Bild-Import: ${kwStrings.length} Keywords via ${analysisImportSourceMain}...`], imported: 0, total: totalEstimate })
    try {
      // Use smartImport which supports keywords array and tracks status properly
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId: analysisImportSourceMain, keywords: kwStrings, count: totalEstimate, targetPerBucket: 500, jobLabel: 'Analyse-Import' }),
      })
      // Poll status via getSmartImportStatus (supports isAnalysis flag)
      let done = false
      let attempts = 0
      while (!done && attempts < 120) {
        await new Promise(r => setTimeout(r, 2000))
        attempts++
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: analysisImportSourceMain, isAnalysis: true }))
          const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
          const data = await res.json()
          const job = data.result?.data ?? data
          setAnalysisImportJobMain({ running: job.running, log: job.log ?? [], imported: job.imported ?? 0, total: job.total ?? 0, error: job.error, finishedAt: job.finishedAt })
          if (!job.running) { done = true; fetchStats() }
        } catch { /* ignore */ }
      }
    } catch (e) {
      setAnalysisImportJobMain(prev => prev ? { ...prev, running: false, error: String(e) } : null)
    } finally {
      setAnalysisImportRunningMain(false)
    }
  }, [lastAnalysis, analysisImportSourceMain, fetchStats])

  const startRecsImport = async () => {
    if (recsRunning) return
    const queriesToRun = recommendations.filter(r => selectedRecs.has(r.query))
    if (queriesToRun.length === 0) return
    const sources: Array<'pexels' | 'unsplash' | 'pixabay'> = ['pexels', 'unsplash', 'pixabay']
    const activeSources = sources.filter(s => apiKeys?.[s])
    if (activeSources.length === 0) return
    setRecsRunning(true)
    const initialJobs: Record<string, SmartImportJob> = {}
    activeSources.forEach(src => {
      initialJobs[src] = { running: true, log: [`🚀 Starte ${queriesToRun.length} Empfehlungen via ${src}...`], imported: 0, total: queriesToRun.length * 400 }
    })
    setRecsJobs(initialJobs)
    setMessage({ text: `Gezielte Importe gestartet: ${queriesToRun.length} Kategorien via ${activeSources.join(' + ')}`, type: 'info' })
    // Start all sources in parallel
    await Promise.allSettled(activeSources.map(src =>
      fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId: src, count: queriesToRun.length * 400, targetPerBucket: 500 }),
      }).catch(() => {
        setRecsJobs(prev => ({ ...prev, [src]: { ...prev[src], running: false, error: 'Fehler beim Starten' } }))
      })
    ))
  }

  // ── Excellent Keywords: fetch & import ──
  const fetchExcellentKeywords = useCallback(async () => {
    setExcellentLoading(true)
    try {
      const res = await fetch('/api/trpc/getExcellentKeywords?input=' + encodeURIComponent(JSON.stringify({ limit: 50, minCount: 2 })), { headers: authHeaders() })
      const data = await res.json()
      const result = data?.result?.data ?? data
      setExcellentKeywords(result.keywords ?? [])
      setExcellentTotal(result.totalExcellent ?? 0)
      // Auto-select top keywords
      setExcellentSelected(new Set((result.keywords ?? []).slice(0, 10).map((k: any) => k.keyword)))
    } catch { /* ignore */ }
    setExcellentLoading(false)
  }, [authHeaders])

  const startExcellentImport = async () => {
    if (excellentImportRunning || excellentSelected.size === 0) return
    const keywords = Array.from(excellentSelected)
    setExcellentImportRunning(true)
    setExcellentImportJob({ running: true, log: [`🌟 Starte Import: ${keywords.length} Exzellent-Keywords via ${excellentImportSource}...`], imported: 0, total: keywords.length * excellentImportCount })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId: excellentImportSource, count: keywords.length * excellentImportCount, keywords, jobLabel: `Exzellent-Keywords (${keywords.length})` }),
      })
      // Poll status
      const pollInterval = setInterval(async () => {
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: excellentImportSource, isAnalysis: true }))
          const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
          const data = await res.json()
          const job = data?.result?.data ?? data
          setExcellentImportJob(prev => ({ ...prev, ...job, log: job.log ?? prev?.log ?? [] }))
          if (!job.running) {
            clearInterval(pollInterval)
            setExcellentImportRunning(false)
            setMessage({ text: `✅ Exzellent-Import fertig: ${job.imported ?? 0} neue Bilder`, type: 'success' })
            fetchStats()
          }
        } catch { /* ignore */ }
      }, 3000)
    } catch {
      setExcellentImportRunning(false)
      setExcellentImportJob(prev => prev ? { ...prev, running: false, error: 'Fehler beim Starten' } : null)
    }
  }

  // fetchStats is declared above (before startAnalysisImportMain) to avoid TDZ
  useEffect(() => { fetchStats() }, [fetchStats])
  useEffect(() => { fetchRecommendations() }, [fetchRecommendations])
  // Sync lastAnalysis and fetch excellent keywords when switching to import tab
  useEffect(() => {
    if (activeTab === 'import') {
      fetchExcellentKeywords()
      try {
        const s = localStorage.getItem('mosaicprint_last_analysis')
        if (s) setLastAnalysis(JSON.parse(s))
      } catch { /* ignore */ }
    }
  }, [activeTab])

  // Poll import job status
  useEffect(() => {
    if (!activeJob) return
    if (activeJob.startsWith('smart_')) return  // smart_ jobs use separate polling
    const interval = setInterval(async () => {
      try {
        const params = encodeURIComponent(JSON.stringify({ sourceId: activeJob }))
        const res = await fetch(`/api/trpc/getImportStatus?input=${params}`, { headers: authHeaders() })
        const data = await res.json()
        const raw = data.result?.data ?? data
        const job: ImportJob = { log: [], ...raw }
        setImportProgress(prev => ({ ...prev, [activeJob]: job }))
        if (!job.running && job.finishedAt) {
          setActiveJob(null)
          fetchStats()
          if (job.error) setMessage({ text: `Fehler: ${typeof job.error === 'string' ? job.error : (job.error as any)?.message ?? JSON.stringify(job.error)}`, type: 'error' })
          else if (job.sessionId && (job.imported ?? 0) > 0) {
            openImportReview(job.sessionId)
          } else {
            setMessage({ text: `Import abgeschlossen: ${job.imported ?? 0} neue Bilder importiert`, type: 'success' })
          }
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeJob, fetchStats, openImportReview])
  // Poll multiple import jobs simultaneously (used by importAll))
  useEffect(() => {
    if (activeJobs.size === 0) return
    const intervals: ReturnType<typeof setInterval>[] = []
    activeJobs.forEach(src => {
      const interval = setInterval(async () => {
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: src }))
          const res = await fetch(`/api/trpc/getImportStatus?input=${params}`, { headers: authHeaders() })
          const data = await res.json()
          const raw = data.result?.data ?? data
          const job: ImportJob = { log: [], ...raw }
          setImportProgress(prev => ({ ...prev, [src]: job }))
          if (!job.running && job.finishedAt) {
            setActiveJobs(prev => { const next = new Set(prev); next.delete(src); return next })
            fetchStats()
            if (job.error) setMessage({ text: `Fehler (${src}): ${typeof job.error === 'string' ? job.error : (job.error as any)?.message ?? JSON.stringify(job.error)}`, type: 'error' })
          }
        } catch { /* ignore */ }
      }, 1500)
      intervals.push(interval)
    })
    return () => intervals.forEach(clearInterval)
  }, [activeJobs, fetchStats])

  // Poll smart import status (for smartImport button only)
  useEffect(() => {
    if (!activeJob?.startsWith('smart_')) return
    const sourceId = activeJob.replace('smart_', '')
    const interval = setInterval(async () => {
      try {
        const params = encodeURIComponent(JSON.stringify({ sourceId }))
        const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
        const data = await res.json()
        const raw2 = data.result?.data ?? data
        const job: SmartImportJob = { log: [], ...raw2 }
        setSmartJob(job)
        if (!job.running && job.finishedAt) {
          setActiveJob(null)
          fetchStats()
          fetchRecommendations()
          if (job.error) setMessage({ text: `Fehler: ${typeof job.error === 'string' ? job.error : (job.error as any)?.message ?? JSON.stringify(job.error)}`, type: 'error' })
          else if ((job as any).sessionId && (job.imported ?? 0) > 0) {
            openImportReview((job as any).sessionId)
          } else {
            setMessage({ text: `Import abgeschlossen: ${job.imported ?? 0} neue Bilder importiert`, type: 'success' })
          }
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeJob, fetchStats, fetchRecommendations, openImportReview])

  // Poll recsJobs (Gezielte Importe - all sources in parallel)
  useEffect(() => {
    if (!recsRunning) return
    const runningSources = Object.keys(recsJobs).filter(src => recsJobs[src]?.running)
    if (runningSources.length === 0) { setRecsRunning(false); return }
    const intervals: ReturnType<typeof setInterval>[] = []
    runningSources.forEach(src => {
      const interval = setInterval(async () => {
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: src }))
          const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
          const data = await res.json()
          // Handle tRPC error responses (e.g. validation errors)
          if (data.error || data[0]?.error) {
            const errMsg = data.error?.message ?? data[0]?.error?.message ?? 'Server-Fehler'
            const job: SmartImportJob = { running: false, log: [`❌ ${errMsg}`], imported: 0, total: 0, error: errMsg, finishedAt: new Date().toISOString() }
            setRecsJobs(prev => ({ ...prev, [src]: job }))
            return
          }
          const raw = data.result?.data ?? data
          const job: SmartImportJob = {
            log: [],
            ...raw,
            error: typeof raw?.error === 'string' ? raw.error : raw?.error ? JSON.stringify(raw.error) : null,
          }
          setRecsJobs(prev => ({ ...prev, [src]: job }))
          if (!job.running && job.finishedAt) {
            setRecsJobs(prev => {
              const updated = { ...prev, [src]: job }
              const allDone = Object.values(updated).every(j => !j.running)
              if (allDone) {
                setRecsRunning(false)
                fetchStats()
                fetchRecommendations()
                const total = Object.values(updated).reduce((sum, j) => sum + (j.imported ?? 0), 0)
                setMessage({ text: `Gezielte Importe abgeschlossen: ${total} neue Bilder importiert`, type: 'success' })
              }
              return updated
            })
          }
        } catch { /* ignore */ }
      }, 1500)
      intervals.push(interval)
    })
    return () => intervals.forEach(clearInterval)
  }, [recsRunning, recsJobs, fetchStats, fetchRecommendations])

  const startImport = async (sourceId: string, batchSize: number) => {
    if (activeJob) return
    setActiveJob(sourceId)
    setMessage({ text: `Import von ${sourceId} gestartet (${batchSize} Bilder, diverse Keywords)...`, type: 'info' })
    setImportProgress(prev => ({ ...prev, [sourceId]: { running: true, log: [], imported: 0, total: batchSize } }))
    try {
      await fetch('/api/trpc/importFromSource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ source: sourceId as 'pexels' | 'unsplash' | 'pixabay', count: batchSize, ...(importCategory ? { category: importCategory } : {}) }),
      })
    } catch {
      setActiveJob(null)
      setMessage({ text: 'Fehler beim Starten des Imports', type: 'error' })
    }
  }

  const startImportAll = async () => {
    if (importAllRunning) return
    setImportAllRunning(true)
    setMessage({ text: `Alle Quellen gleichzeitig gestartet (${importAllBatch} Bilder pro Quelle)...`, type: 'info' })
    try {
      const res = await fetch('/api/trpc/importAll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ count: importAllBatch }),
      })
      const data = await res.json()
      const result = data.result?.data?.json ?? data.result?.data ?? data
      if (result.sources) {
        const srcs: string[] = result.sources
        // Use activeJobs Set for multi-source polling (not activeJob which is single-source)
        setActiveJobs(new Set(srcs))
        srcs.forEach((src: string) => {
          setImportProgress(prev => ({ ...prev, [src]: { running: true, log: [], imported: 0, total: importAllBatch } }))
        })
        setMessage({ text: `${srcs.join(' + ')} gleichzeitig gestartet!`, type: 'success' })
      }
    } catch {
      setMessage({ text: 'Fehler beim Starten des Gesamt-Imports', type: 'error' })
    } finally {
      setImportAllRunning(false)
    }
  }

  const handleIndexLab = async () => {
    if (activeJob) return
    setActiveJob('lab')
    setMessage({ text: '🔄 Quadrant-LAB Backfill gestartet – berechnet 15D-Features für alle Tiles...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/indexLabColors', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      if (parsed?.started) {
        setMessage({ text: '⏳ Backfill läuft im Hintergrund – kann 10-30 Min dauern für 26k Tiles. Seite neu laden für Fortschritt.', type: 'info' })
      } else {
        setMessage({ text: parsed?.message ?? 'Backfill gestartet', type: 'info' })
      }
      fetchStats()
    } catch {
      setMessage({ text: 'Fehler beim Quadrant-LAB Backfill', type: 'error' })
    } finally { setActiveJob(null) }
  }

  const handleBatchReclassify = async () => {
    if (activeJob) return
    if (!window.confirm('Alle Tiles mit dem neuen mehrdimensionalen Score reklassifizieren? Das dauert 30-90 Min für 45k Tiles.')) return
    setActiveJob('reclassify')
    setMessage({ text: '🔄 Reklassifizierung gestartet – Sobel-Edge + Chroma-Varianz + Pixel-Diversität...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/batchReclassifyTileTypes', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      if (parsed?.started) {
        setRebuildStatus({ running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null })
        startRebuildPolling()
        setMessage({ text: '⏳ Reklassifizierung läuft – Fortschrittsbalken wird aktualisiert.', type: 'info' })
      } else {
        setMessage({ text: parsed?.message ?? 'Reklassifizierung gestartet', type: 'info' })
      }
      fetchStats()
    } catch {
      setMessage({ text: 'Fehler bei der Reklassifizierung', type: 'error' })
    } finally { setActiveJob(null) }
  }

  const handleExportSeed = async () => {
    if (activeJob) return
    setActiveJob('seed')
    setMessage({ text: 'Seed wird exportiert...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/exportSeed', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      setMessage({ text: `Seed exportiert: ${parsed?.exported ?? 0} Bilder gespeichert. Jetzt Git-Commit erstellen!`, type: 'success' })
    } catch {
      setMessage({ text: 'Fehler beim Seed-Export', type: 'error' })
    } finally { setActiveJob(null) }
  }

  const handleMirrorDryRun = async () => {
    setMirrorResult('⏳ Zähle...')
    try {
      const res = await fetch('/api/trpc/mirrorTiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ batchSize: mirrorBatch, dryRun: true }),
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      setMirrorResult(`${(parsed?.eligible ?? 0).toLocaleString()} Tiles könnten gespiegelt werden → Pool würde auf ${((parsed?.eligible ?? 0) * 2).toLocaleString()} wachsen`)
    } catch { setMirrorResult('❌ Fehler beim Zählen') }
  }

  const handleMirrorTiles = async () => {
    if (activeJob) return
    setActiveJob('mirror')
    setMirrorResult('⏳ Spiegeln läuft...')
    try {
      const res = await fetch('/api/trpc/mirrorTiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ batchSize: mirrorBatch, dryRun: false }),
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      setMirrorResult(`✅ ${(parsed?.inserted ?? 0).toLocaleString()} gespiegelt, ${(parsed?.skipped ?? 0)} bereits vorhanden. Gesamt-Mirrors: ${(parsed?.existingMirrors ?? 0).toLocaleString()}`)
      fetchStats()
    } catch { setMirrorResult('❌ Fehler beim Spiegeln') }
    finally { setActiveJob(null) }
  }

  const runCustomKeywordImport = async () => {
    const keywords = customKeywords.split(',').map((k: string) => k.trim()).filter((k: string) => k.length > 0)
    if (keywords.length === 0) { setCustomKeywordResult('❌ Bitte mindestens ein Keyword eingeben'); return }
    setCustomKeywordLoading(true)
    setCustomKeywordResult(`⏳ Starte Import für ${keywords.length} Keywords via ${customKeywordSource}...`)
    setCustomKeywordPreview(keywords.map((q: string) => ({ query: q, count: 0, status: '⏳ wartet...' })))
    // Create session on server
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
    try {
      await fetch('/api/trpc/createKeywordSession', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId, keywords, source: customKeywordSource })
      })
    } catch { /* non-critical */ }
    // Fire all imports with sessionId
    for (let i = 0; i < keywords.length; i++) {
      const query = keywords[i]
      setCustomKeywordPreview((prev: Array<{query: string; count: number; status: string}>) => prev.map((p, idx) => idx === i ? { ...p, status: '⏳ gestartet...' } : p))
      try {
        const res = await fetch('/api/trpc/targetedImport', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ sourceId: customKeywordSource, query, count: customKeywordCount, sessionId }),
        })
        const data = await res.json()
        const started = data.result?.data?.json?.started ?? data.result?.data?.started ?? data.started
        const errMsg = data.result?.data?.json?.error ?? data.result?.data?.error ?? data.error?.message ?? (res.ok ? 'Fehler' : `HTTP ${res.status}`)
        if (!started) {
          setCustomKeywordPreview((prev: Array<{query: string; count: number; status: string}>) => prev.map((p, idx) => idx === i ? { ...p, status: `❌ ${errMsg}` } : p))
        }
      } catch (e) {
        setCustomKeywordPreview((prev: Array<{query: string; count: number; status: string}>) => prev.map((p, idx) => idx === i ? { ...p, status: `❌ Netzwerkfehler: ${String(e).slice(0,60)}` } : p))
      }
      if (i < keywords.length - 1) await new Promise(r => setTimeout(r, 300))
    }
    setCustomKeywordResult(`⏳ Import läuft... Warte auf Ergebnisse (${keywords.length} Keywords via ${customKeywordSource})`)
    // Poll session until all done (max 10 min)
    const pollStart = Date.now()
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/trpc/getKeywordSession?input=${encodeURIComponent(JSON.stringify({ sessionId }))}`, { headers: authHeaders() })
        const data = await res.json()
        const sess = data.result?.data ?? data
        if (!sess) return
        // Update preview with actual counts
        setCustomKeywordPreview(keywords.map((q: string) => {
          const r = sess.results?.find((x: any) => x.keyword === q)
          if (!r) return { query: q, count: 0, status: '⏳ wartet...' }
          if (r.status === 'running') return { query: q, count: r.imported, status: `⏳ ${r.imported} importiert...` }
          if (r.status === 'done') return { query: q, count: r.imported, status: `✅ ${r.imported} importiert (${r.rejected} Duplikate)` }
          return { query: q, count: 0, status: `❌ Fehler` }
        }))
        const allDone = sess.finishedAt || sess.results?.every((r: any) => r.status !== 'running')
        const timedOut = Date.now() - pollStart > 10 * 60 * 1000
        if (allDone || timedOut) {
          clearInterval(pollInterval)
          const totalImported = sess.totalImported ?? sess.results?.reduce((s: number, r: any) => s + (r.imported ?? 0), 0) ?? 0
          setCustomKeywordResult(`✅ Import abgeschlossen: ${totalImported} neue Bilder importiert (${keywords.length} Keywords via ${customKeywordSource})`)
          setCustomKeywordLoading(false)
          fetchStats()
          // Open import review modal if tiles were imported
          if (totalImported > 0 && sessionId) {
            openImportReview(sessionId)
          }
          // Generate PDF report
          generateImportReportPdf(sess, keywords, customKeywordSource, customKeywordCount)
        }
      } catch { /* ignore poll errors */ }
    }, 5000)
  }

  const generateImportReportPdf = async (sess: any, keywords: string[], source: string, countPerKeyword: number) => {
    try {
      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const now = new Date()
      const dateStr = now.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      // Header
      doc.setFillColor(30, 30, 50)
      doc.rect(0, 0, 210, 28, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(18)
      doc.setFont('helvetica', 'bold')
      doc.text('MosaicPrint – Import-Bericht', 14, 12)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text(`Erstellt: ${dateStr}`, 14, 20)
      doc.text(`Quelle: ${source.toUpperCase()} | Keywords: ${keywords.length} | Max/Keyword: ${countPerKeyword}`, 14, 26)
      // Summary box
      const totalImported = sess.totalImported ?? sess.results?.reduce((s: number, r: any) => s + (r.imported ?? 0), 0) ?? 0
      const totalBefore = sess.totalBefore ?? 0
      const totalAfter = sess.totalAfter ?? (totalBefore + totalImported)
      doc.setFillColor(240, 248, 240)
      doc.roundedRect(14, 32, 182, 22, 3, 3, 'F')
      doc.setTextColor(30, 100, 30)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text(`Gesamt importiert: ${totalImported} neue Bilder`, 20, 41)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.text(`Pool vorher: ${totalBefore.toLocaleString('de-CH')} Tiles  →  Pool nachher: ${totalAfter.toLocaleString('de-CH')} Tiles`, 20, 49)
      // Table header
      let y = 62
      doc.setFillColor(50, 50, 80)
      doc.rect(14, y - 5, 182, 8, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.text('Keyword', 16, y)
      doc.text('Gefunden', 120, y, { align: 'right' })
      doc.text('Importiert', 150, y, { align: 'right' })
      doc.text('Duplikate', 180, y, { align: 'right' })
      doc.text('Rate', 196, y, { align: 'right' })
      y += 6
      // Table rows
      doc.setFont('helvetica', 'normal')
      keywords.forEach((kw, i) => {
        const r = sess.results?.find((x: any) => x.keyword === kw)
        const imported = r?.imported ?? 0
        const rejected = r?.rejected ?? 0
        const total = r?.total ?? 0
        const rate = total > 0 ? Math.round((imported / total) * 100) : 0
        if (y > 270) { doc.addPage(); y = 20 }
        const bg = i % 2 === 0 ? [248, 248, 252] : [255, 255, 255]
        doc.setFillColor(bg[0], bg[1], bg[2])
        doc.rect(14, y - 4, 182, 7, 'F')
        doc.setTextColor(30, 30, 30)
        doc.setFontSize(8)
        // Truncate long keywords
        const kwDisplay = kw.length > 45 ? kw.slice(0, 42) + '...' : kw
        doc.text(kwDisplay, 16, y)
        doc.text(String(total), 120, y, { align: 'right' })
        doc.setTextColor(imported > 0 ? 0 : 150, imported > 0 ? 120 : 0, 0)
        doc.text(String(imported), 150, y, { align: 'right' })
        doc.setTextColor(100, 100, 100)
        doc.text(String(rejected), 180, y, { align: 'right' })
        doc.setTextColor(rate > 50 ? 0 : 180, rate > 50 ? 120 : 0, 0)
        doc.text(`${rate}%`, 196, y, { align: 'right' })
        y += 7
      })
      // Footer
      doc.setTextColor(150, 150, 150)
      doc.setFontSize(7)
      doc.text('MosaicPrint Admin – Import-Bericht', 14, 290)
      doc.text(`www.mosaicprint.ch`, 196, 290, { align: 'right' })
      // Download
      const filename = `mosaicprint-import-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.pdf`
      doc.save(filename)
    } catch (e) {
      console.error('PDF generation failed:', e)
    }
  }

  const msgColors = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-br from-gray-900 to-gray-800 text-white py-10">
        <div className="max-w-7xl mx-auto px-4">
          <h1 className="text-3xl font-bold mb-1">Admin-Panel</h1>
          <p className="text-gray-400 text-sm">Verwaltung der Bild-Datenbank und Systemeinstellungen</p>
          {/* Quick Stats */}
          <div className="flex flex-wrap gap-6 mt-4">
            <div className="text-center">
              <div className="text-2xl font-bold">{(stats?.total ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">Tiles gesamt</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">{(stats?.labIndexed ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">LAB-indexiert</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-cyan-400">{((stats as any)?.r2Count ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">Auf R2</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-violet-400">{((stats as any)?.mirrorCount ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">Gespiegelt</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-400">{((stats?.total ?? 0) - (stats?.labIndexed ?? 0)).toLocaleString()}</div>
              <div className="text-xs text-gray-400">Offen</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex gap-1">
            {([
              { id: 'database', label: 'Datenbank', icon: Grid },
              { id: 'import', label: 'Import', icon: Upload },
              { id: 'algorithm', label: 'Algorithmus', icon: Settings },
              { id: 'quality', label: 'Qualität & Statistik', icon: BarChart2 },
              { id: 'orders', label: 'Kundenbestellungen', icon: FileText },
            ] as const).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-5 py-4 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === id
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Message Banner */}
        {message && (
          <div className={`mb-6 p-4 rounded-xl text-sm border flex items-center justify-between ${msgColors[message.type]}`}>
            <span>{message.text}</span>
            <button onClick={() => setMessage(null)} className="ml-4 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* ── TAB: Datenbank ── */}
        {activeTab === 'database' && (
          <DatabaseBrowser onMessage={setMessage} />
        )}
        {/* ── TAB: Import ── */}
        {activeTab === 'import' && (
          <div className="space-y-8">
            {/* ── Bild-optimierter Import (wenn Analyse vorhanden) ── */}
            {lastAnalysis && (
              <div className="bg-gradient-to-r from-violet-50 to-indigo-50 rounded-2xl p-6 border-2 border-violet-300">
                <div className="flex items-start justify-between mb-1">
                  <h2 className="font-bold text-violet-900 flex items-center gap-2">
                    <span className="text-xl">🔍</span>
                    Bild-optimierter Import
                    <span className="text-xs font-normal bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full">Empfohlen</span>
                  </h2>
                  <button
                    onClick={() => { localStorage.removeItem('mosaicprint_last_analysis'); setLastAnalysis(null) }}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >✕ Verwerfen</button>
                </div>
                <p className="text-sm text-violet-700 mb-1">
                  Basierend auf der Bildanalyse vom {new Date(lastAnalysis.timestamp).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} Uhr
                  <span className="ml-2 px-2 py-0.5 bg-violet-100 text-violet-600 rounded-full text-xs font-medium capitalize">{lastAnalysis.sceneType?.replace(/_/g, ' ')}</span>
                </p>
                <p className="text-xs text-violet-600 mb-3">Importiert Bilder die speziell für die fehlenden Farbbereiche deines Bildes geeignet sind.</p>
                {/* Keywords */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {lastAnalysis.keywords.map((kw, i) => (
                    <span key={i} className={`px-3 py-1 rounded-full text-xs font-medium border ${
                      kw.priority === 'high' ? 'bg-red-50 border-red-200 text-red-700' :
                      kw.priority === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                      'bg-violet-50 border-violet-200 text-violet-700'
                    }`}>
                      {kw.keyword}
                      {kw.reason && <span className="ml-1 opacity-60">– {kw.reason}</span>}
                    </span>
                  ))}
                </div>
                {/* Controls */}
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={analysisImportSourceMain}
                    onChange={e => setAnalysisImportSourceMain(e.target.value as 'pexels' | 'unsplash' | 'pixabay')}
                    className="text-sm border border-violet-200 rounded-lg px-3 py-2 bg-white text-violet-700"
                    disabled={analysisImportRunningMain}
                  >
                    <option value="pexels">Pexels</option>
                    <option value="unsplash">Unsplash</option>
                    <option value="pixabay">Pixabay</option>
                    <option value="flickr">Flickr</option>
                  </select>
                  <button
                    onClick={startAnalysisImportMain}
                    disabled={analysisImportRunningMain}
                    className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white font-semibold px-5 py-2 rounded-xl transition-colors text-sm"
                  >
                    {analysisImportRunningMain ? <><span className="animate-spin inline-block">⏳</span> Import läuft...</> : <><span>🚀</span> {lastAnalysis.keywords.length * 30} Bilder importieren</>}
                  </button>
                </div>
                {/* Progress */}
                {analysisImportJobMain && (
                  <div className="mt-3 space-y-2">
                    {(analysisImportJobMain.total ?? 0) > 0 && (
                      <div className="w-full bg-violet-100 rounded-full h-2">
                        <div className="bg-violet-500 h-2 rounded-full transition-all" style={{ width: `${Math.min(100, ((analysisImportJobMain.imported ?? 0) / (analysisImportJobMain.total ?? 1)) * 100)}%` }} />
                      </div>
                    )}
                    <div className="text-xs text-violet-700 font-medium">
                      {analysisImportJobMain.imported ?? 0} / {analysisImportJobMain.total ?? 0} Bilder importiert
                      {analysisImportJobMain.finishedAt && <span className="ml-2 text-green-600">✅ Fertig</span>}
                      {analysisImportJobMain.error && <span className="ml-2 text-red-600">❌ {typeof analysisImportJobMain.error === 'string' ? analysisImportJobMain.error : (analysisImportJobMain.error as any)?.message ?? JSON.stringify(analysisImportJobMain.error)}</span>}
                    </div>
                    {analysisImportJobMain.log.length > 0 && (
                      <div className="bg-white rounded-lg p-2 max-h-20 overflow-y-auto text-xs text-gray-500 font-mono">
                        {analysisImportJobMain.log.slice(-4).map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Exzellent-Keywords Import ── */}
            <div className="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-2xl p-6 border-2 border-amber-300">
              <div className="flex items-start justify-between mb-1">
                <h2 className="font-bold text-amber-900 flex items-center gap-2">
                  <span className="text-xl">🌟</span>
                  Import aus Exzellent-Keywords
                  <span className="text-xs font-normal bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full">
                    {excellentTotal} exzellente Bilder
                  </span>
                </h2>
                <button
                  onClick={fetchExcellentKeywords}
                  disabled={excellentLoading}
                  className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  {excellentLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Aktualisieren
                </button>
              </div>
              <p className="text-sm text-amber-700 mb-3">
                Keywords die bereits exzellente Bilder geliefert haben – gezielt mehr davon importieren.
              </p>

              {excellentLoading ? (
                <div className="flex items-center gap-2 text-sm text-amber-500 mb-4">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Lade Exzellent-Keywords...
                </div>
              ) : excellentKeywords.length === 0 ? (
                <div className="text-sm text-amber-500 mb-4">Keine exzellenten Keywords gefunden. Zuerst Bilder mit Gemini analysieren.</div>
              ) : (
                <>
                  {/* Select/Deselect controls */}
                  <div className="flex items-center gap-3 mb-3">
                    <button
                      onClick={() => setExcellentSelected(new Set(excellentKeywords.map(k => k.keyword)))}
                      className="text-xs text-amber-700 hover:underline"
                    >Alle auswählen</button>
                    <span className="text-amber-300">|</span>
                    <button
                      onClick={() => setExcellentSelected(new Set())}
                      className="text-xs text-amber-500 hover:underline"
                    >Alle abwählen</button>
                    <span className="text-xs text-amber-400 ml-auto">{excellentSelected.size} / {excellentKeywords.length} ausgewählt</span>
                  </div>

                  {/* Keyword chips */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    {excellentKeywords.map(kw => {
                      const isSelected = excellentSelected.has(kw.keyword)
                      return (
                        <button
                          key={kw.keyword}
                          onClick={() => {
                            const next = new Set(excellentSelected)
                            if (isSelected) next.delete(kw.keyword); else next.add(kw.keyword)
                            setExcellentSelected(next)
                          }}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                            isSelected
                              ? 'bg-amber-100 border-amber-400 text-amber-800 ring-1 ring-amber-400'
                              : 'bg-white border-gray-200 text-gray-400 opacity-60'
                          }`}
                        >
                          {kw.keyword}
                          <span className="ml-1.5 opacity-70">×{kw.count}</span>
                          <span className="ml-1 opacity-50">⌀{kw.avgScore}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <select
                  value={excellentImportSource}
                  onChange={e => setExcellentImportSource(e.target.value as 'pexels' | 'unsplash' | 'pixabay' | 'flickr')}
                  className="text-sm border border-amber-200 rounded-lg px-3 py-2 bg-white text-amber-700"
                  disabled={excellentImportRunning}
                >
                  <option value="flickr">🔵 Flickr (CC-Lizenz)</option>
                  <option value="pixabay">🟠 Pixabay</option>
                  <option value="pexels">🟢 Pexels</option>
                  <option value="unsplash">🟣 Unsplash</option>
                </select>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-amber-700">Bilder/Keyword:</span>
                  <input
                    type="number"
                    value={excellentImportCount}
                    onChange={e => setExcellentImportCount(Math.max(10, Math.min(500, Number(e.target.value))))}
                    className="w-20 text-sm border border-amber-200 rounded-lg px-2 py-1.5 text-center"
                    min={10} max={500} step={10}
                    disabled={excellentImportRunning}
                  />
                </div>
                <button
                  onClick={startExcellentImport}
                  disabled={excellentImportRunning || excellentSelected.size === 0}
                  className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-xl transition-colors text-sm"
                >
                  {excellentImportRunning
                    ? <><span className="animate-spin inline-block">⏳</span> Import läuft...</>
                    : <><span>🌟</span> {excellentSelected.size} Keywords × {excellentImportCount} importieren</>}
                </button>
              </div>

              {/* Progress */}
              {excellentImportJob && (
                <div className="mt-3 space-y-2">
                  {(excellentImportJob.total ?? 0) > 0 && (
                    <div className="w-full bg-amber-100 rounded-full h-2">
                      <div className="bg-amber-500 h-2 rounded-full transition-all" style={{ width: `${Math.min(100, ((excellentImportJob.imported ?? 0) / (excellentImportJob.total ?? 1)) * 100)}%` }} />
                    </div>
                  )}
                  <div className="text-xs text-amber-700 font-medium">
                    {excellentImportJob.imported ?? 0} / {excellentImportJob.total ?? 0} Bilder importiert
                    {excellentImportJob.finishedAt && <span className="ml-2 text-green-600">✅ Fertig</span>}
                    {excellentImportJob.error && <span className="ml-2 text-red-600">❌ {typeof excellentImportJob.error === 'string' ? excellentImportJob.error : JSON.stringify(excellentImportJob.error)}</span>}
                  </div>
                  {(excellentImportJob.log ?? []).length > 0 && (
                    <div className="bg-white rounded-lg p-2 max-h-24 overflow-y-auto text-xs text-gray-500 font-mono">
                      {(excellentImportJob.log ?? []).slice(-6).map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* API Key Status */}
            <div className="bg-white rounded-2xl p-6 border border-gray-200">
              <h2 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-yellow-500" />
                API-Key Status
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { key: 'stripe', label: 'Stripe (Checkout)', active: apiKeys?.stripe },
                  { key: 'unsplash', label: 'Unsplash', active: apiKeys?.unsplash },
                  { key: 'pexels', label: 'Pexels', active: apiKeys?.pexels },
                  { key: 'pixabay', label: 'Pixabay', active: apiKeys?.pixabay },
                ].map(({ key, label, active }) => (
                  <div key={key} className={`flex items-center gap-3 p-3 rounded-xl border ${active ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    {active ? <CheckCircle className="w-5 h-5 text-green-600 shrink-0" /> : <XCircle className="w-5 h-5 text-red-500 shrink-0" />}
                    <div>
                      <div className="font-medium text-sm text-gray-900">{label}</div>
                      <div className={`text-xs ${active ? 'text-green-700' : 'text-red-600'}`}>{active ? 'Konfiguriert ✓' : 'Kein Key'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* R2 Migration Panel */}
            <R2MigrationPanel />


            {/* Gezielte Importe (Empfehlungen) – ENTFERNT: zu viele Optionen, Keyword-Generator ist die bessere Alternative */}
            {false && <div className="bg-white rounded-2xl p-6 border border-amber-200">
              <div className="flex items-start justify-between mb-1">
                <h2 className="font-bold text-gray-900 flex items-center gap-2">
                  <Zap className="w-5 h-5 text-amber-500" />
                  Gezielte Importe (Empfehlungen)
                </h2>
                <button
                  onClick={fetchRecommendations}
                  disabled={recsLoading}
                  className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  {recsLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Aktualisieren
                </button>
              </div>
              <p className="text-gray-500 text-sm mb-4">
                KI analysiert den aktuellen Tile-Pool und empfiehlt die wichtigsten Import-Kategorien.
                Wähle einzelne Kategorien oder starte alle gleichzeitig.
              </p>

              {/* Recommendation tiles */}
              {recsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Analysiere Tile-Pool...
                </div>
              ) : recommendations.length === 0 ? (
                <div className="text-sm text-gray-400 mb-4">Keine Empfehlungen verfügbar. Klicke auf Aktualisieren.</div>
              ) : (
                <div className="mb-4">
                  {/* Select all / deselect all */}
                  <div className="flex items-center gap-3 mb-3">
                    <button
                      onClick={() => setSelectedRecs(new Set(recommendations.map(r => r.query)))}
                      className="text-xs text-blue-600 hover:underline"
                    >Alle auswählen</button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => setSelectedRecs(new Set())}
                      className="text-xs text-gray-500 hover:underline"
                    >Alle abwählen</button>
                    <span className="text-xs text-gray-400 ml-auto">{selectedRecs.size} / {recommendations.length} ausgewählt</span>
                  </div>
                  {/* Tile grid */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {(recsExpanded ? recommendations : recommendations.slice(0, 12)).map(rec => {
                      const isSelected = selectedRecs.has(rec.query)
                      const isPortrait = rec.subject === 'portrait'
                      const priorityColor = isPortrait
                        ? 'border-rose-400 bg-rose-50'
                        : rec.priority >= 1.5 ? 'border-red-300 bg-red-50'
                        : rec.priority >= 1.0 ? 'border-amber-300 bg-amber-50'
                        : 'border-gray-200 bg-gray-50'
                      const priorityBadge = isPortrait
                        ? 'bg-rose-100 text-rose-700'
                        : rec.priority >= 1.5 ? 'bg-red-100 text-red-700'
                        : rec.priority >= 1.0 ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600'
                      return (
                        <button
                          key={rec.query}
                          onClick={() => {
                            const next = new Set(selectedRecs)
                            if (isSelected) next.delete(rec.query); else next.add(rec.query)
                            setSelectedRecs(next)
                          }}
                          className={`text-left rounded-xl border-2 p-3 transition-all ${
                            isSelected ? `${priorityColor} ring-2 ${isPortrait ? 'ring-rose-400' : 'ring-amber-400'}` : 'border-gray-200 bg-white opacity-50'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-gray-800 truncate">{rec.label}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ml-1 shrink-0 ${priorityBadge}`}>
                              {isPortrait ? '🧑' : rec.priority >= 1.5 ? '🔥' : rec.priority >= 1.0 ? '⚡' : '↑'}{rec.priority.toFixed(1)}×
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 truncate">{rec.query}</div>
                          <div className="text-xs text-gray-500 mt-1">Fehlt: {rec.deficit} Bilder</div>
                          {isPortrait && (
                            <div className="mt-1.5 text-xs font-medium text-rose-600 bg-rose-100 rounded px-1.5 py-0.5 inline-block">👤 Portrait-Qualität</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {recommendations.length > 12 && (
                    <button
                      onClick={() => setRecsExpanded(!recsExpanded)}
                      className="mt-2 text-xs text-amber-600 hover:underline"
                    >
                      {recsExpanded ? '▲ Weniger anzeigen' : `▼ Alle ${recommendations.length} anzeigen`}
                    </button>
                  )}
                </div>
              )}

              {/* Job progress - one row per source */}
              {Object.keys(recsJobs).length > 0 && (
                <div className="mb-4 space-y-2">
                  {(['pexels', 'unsplash', 'pixabay'] as const).filter(src => recsJobs[src]).map(src => {
                    const job = recsJobs[src]
                    return (
                      <div key={src} className="bg-gray-50 rounded-xl p-3 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-gray-700 capitalize">{src}</span>
                          <span className={job.running ? 'text-amber-600' : job.error ? 'text-red-500' : 'text-green-600'}>
                            {job.running ? `⏳ ${job.imported ?? 0} importiert` : job.error ? `❌ ${typeof job.error === 'string' ? job.error : JSON.stringify(job.error)}` : `✅ ${job.imported ?? 0} neu`}
                          </span>
                        </div>
                        {job.running && (
                          <div className="w-full bg-gray-200 rounded-full h-1 mb-1">
                            <div className="bg-amber-500 h-1 rounded-full transition-all" style={{ width: `${Math.min(100, ((job.imported ?? 0) / (job.total || 1)) * 100)}%` }} />
                          </div>
                        )}
                        <div className="max-h-12 overflow-y-auto space-y-0.5">
                          {(job.log ?? []).slice(-4).map((l, i) => (
                            <div key={i} className={l.startsWith('✓') ? 'text-green-600' : l.startsWith('✅') ? 'text-green-700 font-medium' : 'text-gray-500'}>{l}</div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={startRecsImport}
                  disabled={recsRunning || selectedRecs.size === 0 || (!apiKeys?.pexels && !apiKeys?.unsplash && !apiKeys?.pixabay)}
                  className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-xl transition-colors text-sm"
                >
                  {recsRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {recsRunning
                    ? 'Import läuft (alle Quellen)...'
                    : selectedRecs.size === recommendations.length
                      ? `⚡ Alle ${selectedRecs.size} via Pexels + Unsplash + Pixabay`
                      : `⚡ ${selectedRecs.size} Empfehlungen (alle Quellen)`}
                </button>
              </div>
            </div>}

            {/* ── Unified Import Section ── */}
            <div className="bg-white rounded-2xl p-6 border border-indigo-200">
              <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                <Download className="w-5 h-5 text-indigo-500" />
                Bilder importieren
              </h2>
              <p className="text-gray-500 text-sm mb-4">
                Importiert diverse Bilder via randomisierter Keyword-Suche (keine Duplikate dank URL-Deduplizierung).
                Pexels liefert bis zu 80 Bilder/Keyword, Unsplash bis zu 30.
              </p>





              {/* ── Freie Keyword-Eingabe ── */}
              <div className="mb-4 p-4 bg-emerald-50 rounded-xl border border-emerald-200">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-emerald-900">🔍 Eigene Keywords importieren</span>
                  <span className="text-xs text-emerald-600">Kommagetrennte Keywords – jedes Keyword wird separat importiert</span>
                </div>
                <textarea
                  value={customKeywords}
                  onChange={e => setCustomKeywords(e.target.value)}
                  placeholder="z.B. white fog minimal, pure white background, snow texture, dark night sky, dark wood texture, monochrome blue abstract"
                  rows={3}
                  className="w-full text-sm border border-emerald-300 rounded-lg px-3 py-2 bg-white text-gray-800 resize-none mb-2 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={customKeywordSource}
                    onChange={e => setCustomKeywordSource(e.target.value as 'pexels' | 'unsplash' | 'pixabay')}
                    className="text-sm border border-emerald-300 rounded-lg px-3 py-1.5 bg-white text-gray-800"
                    disabled={customKeywordLoading}
                  >
                    <option value="pixabay">🟠 Pixabay (200/Keyword, empfohlen)</option>
                    <option value="pexels">🟢 Pexels (80/Keyword)</option>
                    <option value="unsplash">🟣 Unsplash (bis 5000/Keyword)</option>
                    <option value="flickr">🔵 Flickr (bis 5000/Keyword, CC-Lizenz)</option>
                  </select>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-emerald-700">Bilder/Keyword:</span>
                    <input
                      type="number"
                      value={customKeywordCount}
                      onChange={e => setCustomKeywordCount(Math.max(10, Math.min(5000, Number(e.target.value))))} 
                      className="w-20 text-sm border border-emerald-300 rounded-lg px-2 py-1.5 text-center"
                      min={10} max={5000} step={10}
                      disabled={customKeywordLoading}
                    />
                  </div>
                  <button
                    onClick={runCustomKeywordImport}
                    disabled={customKeywordLoading || !customKeywords.trim()}
                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm"
                  >
                    {customKeywordLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>▶</span>}
                    {customKeywordLoading ? 'Läuft...' : '🔍 Import starten'}
                  </button>
                </div>
                {customKeywords.trim() && (
                  <div className="mt-2 text-xs text-emerald-700">
                    {customKeywords.split(',').filter(k => k.trim()).length} Keywords erkannt: 
                    {customKeywords.split(',').filter(k => k.trim()).map((k, i) => (
                      <span key={i} className="inline-block bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5 mr-1 mb-1">{k.trim()}</span>
                    ))}
                  </div>
                )}
                {customKeywordResult && (
                  <div className={`mt-2 text-xs font-medium ${customKeywordResult.startsWith('❌') ? 'text-red-600' : 'text-emerald-700'}`}>{customKeywordResult}</div>
                )}
                {customKeywordPreview.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {customKeywordPreview.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="font-medium text-gray-700 truncate flex-1">"{p.query}"</span>
                        <span className={p.status.startsWith('✅') ? 'text-green-600' : p.status.startsWith('❌') ? 'text-red-500' : 'text-amber-500'}>{p.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Keyword-Generator ── */}
              <KeywordGenerator onInsertKeywords={(kws) => setCustomKeywords(prev => prev ? prev + ', ' + kws : kws)} />


            </div>

            {/* LAB + Seed */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white rounded-2xl p-6 border border-green-300">
                <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <Database className="w-5 h-5 text-green-600" />
                  15D Quadrant-LAB Backfill
                </h3>
                <p className="text-gray-600 text-sm mb-2">
                  Berechnet <strong>Quadrant-LAB-Werte</strong> (TL/TR/BL/BR) für alle Tiles.
                  Ohne diese Daten nutzt der Algorithmus nur 3D statt 15D – Mosaic-Qualität ist stark eingeschränkt!
                </p>
                {stats && stats.total > 0 && (
                  <>
                    <div className="mb-1">
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>Quadrant-LAB indexiert</span>
                        <span className="font-semibold">{(stats as any).quadrantIndexed?.toLocaleString() ?? '?'} / {stats.total.toLocaleString()}</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full transition-all"
                          style={{ width: `${Math.round(((stats as any).quadrantIndexed ?? 0) / stats.total * 100)}%` }} />
                      </div>
                    </div>
                    {((stats as any).quadrantMissing ?? stats.total) > 0 && (
                      <p className="text-xs text-red-600 font-semibold mb-2">
                        ⚠️ {((stats as any).quadrantMissing ?? stats.total).toLocaleString()} Tiles fehlen noch Quadrant-Daten!
                      </p>
                    )}
                  </>
                )}
                <button onClick={handleIndexLab} disabled={!!activeJob} className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm">
                  {activeJob === 'lab' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                  {activeJob === 'lab' ? 'Backfill läuft...' : `Quadrant-LAB berechnen (${(((stats as any)?.quadrantMissing) ?? stats?.total ?? 0).toLocaleString()} Tiles)`}
                </button>
              </div>

              <div className="bg-white rounded-2xl p-6 border border-indigo-200">
                <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <Save className="w-5 h-5 text-indigo-600" />
                  Seed-Datei exportieren
                </h3>
                <p className="text-gray-600 text-sm mb-1">
                  Speichert alle Tile-Bilder als <code className="bg-gray-100 px-1 rounded">seed-tiles.json</code>.
                  Diese Datei wird beim Serverstart automatisch importiert – auch nach einem Reset.
                </p>
                <p className="text-amber-700 text-xs mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  ⚠️ Nach dem Export unbedingt einen Git-Commit erstellen!
                </p>
                <button onClick={handleExportSeed} disabled={!!activeJob} className="flex items-center gap-2 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm">
                  {activeJob === 'seed' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Seed exportieren ({(stats?.total ?? 0).toLocaleString()} Bilder)
                </button>
              </div>

              {/* Mirror Tiles Card */}
              <div className="bg-white rounded-2xl p-6 border border-cyan-300">
                <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <span className="text-cyan-600 text-lg">⟺</span>
                  Tiles spiegeln
                  <span className="text-xs font-normal bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">Neu</span>
                </h3>
                <p className="text-gray-600 text-sm mb-2">
                  Erstellt <strong>horizontal gespiegelte Kopien</strong> aller Tiles.
                  Verdoppelt den Pool effektiv ohne neue Downloads – LAB-Quadranten werden korrekt getauscht (TL↔TR, BL↔BR).
                </p>
                {mirrorResult && (
                  <div className="mb-3 text-xs bg-cyan-50 border border-cyan-200 rounded-lg px-3 py-2 text-cyan-800">
                    {mirrorResult}
                  </div>
                )}
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-xs text-gray-500">Batch:</label>
                  <input type="number" value={mirrorBatch} onChange={e => setMirrorBatch(Math.max(100, Math.min(2000, Number(e.target.value))))} className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1 text-center" min={100} max={2000} disabled={!!activeJob} />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleMirrorDryRun} disabled={!!activeJob} className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 text-gray-700 font-medium px-3 py-2 rounded-xl transition-colors text-xs">
                    Zählen
                  </button>
                  <button onClick={handleMirrorTiles} disabled={!!activeJob} className="flex items-center gap-2 bg-cyan-500 hover:bg-cyan-600 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm">
                    {activeJob === 'mirror' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>⟺</span>}
                    {activeJob === 'mirror' ? 'Spiegeln...' : `${mirrorBatch} spiegeln`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

         {/* ── TAB: Algorithmus ── */}
        {activeTab === 'algorithm' && (
          <AlgorithmSettings />
        )}
        {/* ── TAB: Qualität & Statistik ── */}
        {activeTab === 'quality' && (
          <QualityAssurance onMessage={setMessage} />
        )}

        {/* ── TAB: Kundenbestellungen ── */}
        {activeTab === 'orders' && (
          <OrdersPanel onMessage={setMessage} />
        )}

      </div>

      {/* ── Import Review Modal ── */}
      {importReviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Import-Vorschau</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {importReviewLoading
                    ? 'Lade Tiles…'
                    : `${importReviewTiles.length} Tiles importiert – klicke zum Abwählen`}
                </p>
              </div>
              <button
                onClick={() => setImportReviewOpen(false)}
                className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Selection Stats */}
            {!importReviewLoading && importReviewTiles.length > 0 && (
              <div className="px-6 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700">
                  <span className="text-green-600 font-bold">{importReviewTiles.length - importReviewRejected.size}</span> ausgewählt
                  {importReviewRejected.size > 0 && (
                    <span className="ml-2 text-red-500">({importReviewRejected.size} abgewählt)</span>
                  )}
                </span>
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={() => setImportReviewRejected(new Set())}
                    className="text-xs px-3 py-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 font-medium"
                  >
                    Alle auswählen
                  </button>
                  <button
                    onClick={() => setImportReviewRejected(new Set(importReviewTiles.map(t => t.id)))}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 font-medium"
                  >
                    Alle abwählen
                  </button>
                </div>
              </div>
            )}

            {/* Tile Grid */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {importReviewLoading ? (
                <div className="flex items-center justify-center h-40 text-gray-400">
                  <span className="animate-spin mr-2">⟳</span> Lade Vorschau…
                </div>
              ) : importReviewTiles.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-gray-400">
                  Keine Tiles gefunden
                </div>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                  {importReviewTiles.map(tile => {
                    const rejected = importReviewRejected.has(tile.id)
                    return (
                      <div
                        key={tile.id}
                        onClick={() => {
                          setImportReviewRejected(prev => {
                            const next = new Set(prev)
                            if (next.has(tile.id)) next.delete(tile.id)
                            else next.add(tile.id)
                            return next
                          })
                        }}
                        className={`relative cursor-pointer rounded-lg overflow-hidden aspect-square border-2 transition-all ${
                          rejected
                            ? 'border-red-500 opacity-50'
                            : 'border-transparent hover:border-green-400'
                        }`}
                        title={tile.source_url}
                      >
                        <img
                          src={tile.tile128_url}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        {rejected && (
                          <div className="absolute inset-0 flex items-center justify-center bg-red-500/30">
                            <X className="w-5 h-5 text-red-600" />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between gap-3">
              <button
                onClick={() => {
                  // Discard all: reject all tiles
                  setImportReviewRejected(new Set(importReviewTiles.map(t => t.id)))
                  confirmImportReview()
                }}
                disabled={importReviewConfirming || importReviewLoading}
                className="text-sm px-4 py-2 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Alle verwerfen
              </button>
              <div className="flex gap-3">
                <button
                  onClick={() => setImportReviewOpen(false)}
                  disabled={importReviewConfirming}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  Abbrechen
                </button>
                <button
                  onClick={confirmImportReview}
                  disabled={importReviewConfirming || importReviewLoading || importReviewTiles.length === 0}
                  className="flex items-center gap-2 text-sm px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold disabled:opacity-50"
                >
                  {importReviewConfirming ? (
                    <><span className="animate-spin">⟳</span> Speichere…</>
                  ) : importReviewRejected.size === 0 ? (
                    <>✅ Alle speichern ({importReviewTiles.length})</>
                  ) : (
                    <>✅ Auswahl speichern ({importReviewTiles.length - importReviewRejected.size})</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Import Card ───────────────────────────────────────────────────────────────
interface ImportCardProps {
  title: string; description: string; icon: React.ReactNode
  color: 'blue' | 'purple' | 'green' | 'orange'; available: boolean
  job?: ImportJob; isActive: boolean
  onImport: (n: number) => void; defaultBatch: number; maxBatch: number
}
function ImportCard({ title, description, icon, color, available, job, isActive, onImport, defaultBatch, maxBatch }: ImportCardProps) {
  const [batch, setBatch] = useState(defaultBatch)
  const colorMap = {
    blue:   { bg: 'bg-blue-100',   btn: 'bg-blue-500 hover:bg-blue-600',   text: 'text-blue-600' },
    purple: { bg: 'bg-purple-100', btn: 'bg-purple-500 hover:bg-purple-600', text: 'text-purple-600' },
    green:  { bg: 'bg-green-100',  btn: 'bg-green-500 hover:bg-green-600',  text: 'text-green-600' },
    orange: { bg: 'bg-orange-100', btn: 'bg-orange-500 hover:bg-orange-600', text: 'text-orange-600' },
  }
  const c = colorMap[color]
  return (
    <div className={`bg-white rounded-2xl p-6 border ${available ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-10 h-10 ${c.bg} rounded-xl flex items-center justify-center`}>{icon}</div>
        <div>
          <h3 className="font-bold text-gray-900 text-sm">{title}</h3>
          {!available && <span className="text-xs text-red-500">Kein API-Key</span>}
        </div>
      </div>
      <p className="text-gray-600 text-xs mb-4">{description}</p>
      {job && (
        <div className="mb-3 text-xs text-gray-600 bg-gray-50 rounded-lg p-2">
          {job.running ? `Läuft... ${job.imported ?? 0}/${job.total ?? '?'} importiert`
            : job.error ? <span className="text-red-600">{typeof job.error === 'string' ? job.error : (job.error as any)?.message ?? JSON.stringify(job.error)}</span>
            : `Fertig: ${job.imported ?? 0} importiert`}
          {job.log && job.log.length > 0 && (
            <div className="mt-1 text-gray-400 text-xs max-h-16 overflow-y-auto">
              {job.log.slice(-3).map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-gray-500 shrink-0">Anzahl:</label>
        <input type="number" value={batch} onChange={e => setBatch(Math.max(1, Math.min(maxBatch, Number(e.target.value))))} className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1 text-center" min={1} max={maxBatch} disabled={isActive || !available} />
      </div>
      <button onClick={() => onImport(batch)} disabled={isActive || !available} className={`flex items-center gap-2 ${c.btn} disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm w-full justify-center`}>
        {isActive ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {isActive ? 'Import läuft...' : `${batch} Bilder importieren`}
      </button>
    </div>
  )
}

// ── Database Browser ──────────────────────────────────────────────────────────
function DatabaseBrowser({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const { authHeaders } = useAuth();
  const [images, setImages] = useState<TileImage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [dbStats, setDbStats] = useState<DbStatsDetail | null>(null)
  const [sourceFilter, setSourceFilter] = useState('alle')
  const [colorFilter, setColorFilter] = useState('alle')
  const [brightnessFilter, setBrightnessFilter] = useState('alle')
  const [showStats, setShowStats] = useState(true)
  const [selectedImage, setSelectedImage] = useState<TileImage | null>(null)
  const [dedupLoading, setDedupLoading] = useState(false)
  const [dedupResult, setDedupResult] = useState<string | null>(null)
  const [dedupProgress, setDedupProgress] = useState<{ before: number; deleted: number; after: number } | null>(null)
  const [constraintLoading, setConstraintLoading] = useState(false)
  const [constraintResult, setConstraintResult] = useState<string | null>(null)
  const [shutterstockLoading, setShutterstockLoading] = useState(false)
  const [shutterstockResult, setShutterstockResult] = useState<string | null>(null)
  const [grayCleanupLoading, setGrayCleanupLoading] = useState(false)
  const [grayCleanupResult, setGrayCleanupResult] = useState<string | null>(null)
  const [poolOptimizeRunning, setPoolOptimizeRunning] = useState(false)
  const [poolOptimizeResult, setPoolOptimizeResult] = useState<string | null>(null)
  const [poolImportProgress, setPoolImportProgress] = useState<{
    imported: number; total: number; log: string[]; startedAt: string | null; error: string | null; report: any | null
  } | null>(null)
  const [quickImportLoading, setQuickImportLoading] = useState<string | null>(null)
  const [quickImportResult, setQuickImportResult] = useState<Record<string, string>>({})
  const [pdfExporting, setPdfExporting] = useState(false)
  const [importedSince, setImportedSince] = useState('alle')
  const [qualityStatusFilter, setQualityStatusFilter] = useState('alle')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [sourceDeleting, setSourceDeleting] = useState(false)
  const [tileTypeFilter, setTileTypeFilter] = useState('alle')
  const [warmCoolFilter, setWarmCoolFilter] = useState('alle')
  const [saturationFilter, setSaturationFilter] = useState('alle')
  const [geminiFilter, setGeminiFilter] = useState('alle')
  const [rebuildStatus, setRebuildStatus] = useState<{ running: boolean; log: string[]; startedAt: string | null; finishedAt: string | null; error: string | null } | null>(null)
  const rebuildPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const LIMIT = 60

  const startRebuildPolling = useCallback(() => {
    if (rebuildPollRef.current) return
    rebuildPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/trpc/getRebuildStatus', { headers: authHeaders() })
        const data = await res.json()
        const status = data.result?.data ?? data
        setRebuildStatus(status)
        if (!status?.running) {
          clearInterval(rebuildPollRef.current!)
          rebuildPollRef.current = null
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [])

  const fetchDbStats = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getDbStats', { headers: authHeaders() })
      const data = await res.json()
      setDbStats(data.result?.data?.json ?? data.result?.data ?? data)
    } catch { /* ignore */ }
  }, [authHeaders])

  const handleBatchReclassify = async () => {
    if (!window.confirm('Alle Tiles mit dem neuen mehrdimensionalen Score reklassifizieren? Das dauert 30-90 Min für 45k Tiles.')) return
    onMessage({ text: '🔄 Reklassifizierung gestartet – Sobel-Edge + Chroma-Varianz + Pixel-Diversität...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/batchReclassifyTileTypes', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      if (parsed?.started) {
        setRebuildStatus({ running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null })
        startRebuildPolling()
        onMessage({ text: '⏳ Reklassifizierung läuft – Fortschrittsbalken wird aktualisiert.', type: 'info' })
      } else {
        onMessage({ text: parsed?.message ?? 'Reklassifizierung gestartet', type: 'info' })
      }
      fetchDbStats()
    } catch {
      onMessage({ text: 'Fehler bei der Reklassifizierung', type: 'error' })
    }
  }

  const fetchImages = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page: p, limit: LIMIT }
      if (sourceFilter !== 'alle') params.sourceId = sourceFilter
      if (colorFilter !== 'alle') params.colorFilter = colorFilter
      if (brightnessFilter !== 'alle') params.brightnessFilter = brightnessFilter
      if (warmCoolFilter !== 'alle') params.warmCoolFilter = warmCoolFilter
      if (saturationFilter !== 'alle') params.saturationFilter = saturationFilter
      if (geminiFilter !== 'alle') params.geminiFilter = geminiFilter
      if (importedSince !== 'alle') params.importedSince = importedSince
      if (qualityStatusFilter !== 'alle') params.qualityStatus = qualityStatusFilter
      if (tileTypeFilter !== 'alle') params.tileType = tileTypeFilter
      const encoded = encodeURIComponent(JSON.stringify(params))
      const res = await fetch(`/api/trpc/getAdminImagesFiltered?input=${encoded}`, { headers: authHeaders() })
      const data = await res.json()
      const parsed = data.result?.data ?? data
      setImages(parsed.images ?? [])
      setTotal(parsed.total ?? 0)
    } catch {
      onMessage({ text: 'Fehler beim Laden der Bilder', type: 'error' })
    } finally { setLoading(false) }
  }, [sourceFilter, colorFilter, brightnessFilter, warmCoolFilter, saturationFilter, geminiFilter, importedSince, qualityStatusFilter, tileTypeFilter, onMessage, authHeaders])

  const runDedup = useCallback(async () => {
    if (!confirm('Duplikate aus der Datenbank entfernen? Jede source_url wird nur einmal behalten (niedrigste ID). Dieser Vorgang kann nicht rückgängig gemacht werden.')) return
    setDedupLoading(true)
    setDedupResult(null)
    try {
      const res = await fetch('/api/admin/dedup-tiles', { method: 'POST', headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setDedupResult(`✅ ${data.message}`)
        setDedupProgress({ before: data.before?.total ?? 0, deleted: data.deleted ?? 0, after: data.after?.total ?? 0 })
        fetchDbStats()
        fetchImages(1)
      } else {
        setDedupResult(`❌ Fehler: ${typeof data.error === 'string' ? data.error : data.error?.message ?? JSON.stringify(data.error)}`)
      }
    } catch (e) {
      setDedupResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setDedupLoading(false)
    }
  }, [fetchDbStats, fetchImages])

  const runAddConstraint = useCallback(async () => {
    if (!confirm('UNIQUE-Constraint auf source_url setzen? Damit können künftig keine Duplikate mehr importiert werden. Stelle sicher, dass du zuerst Duplikate entfernt hast.')) return
    setConstraintLoading(true)
    setConstraintResult(null)
    try {
      const res = await fetch('/api/admin/add-unique-constraint', { method: 'POST', headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setConstraintResult(`✅ ${data.message}`)
      } else {
        setConstraintResult(`❌ Fehler: ${typeof data.error === 'string' ? data.error : data.error?.message ?? JSON.stringify(data.error)}`)
      }
    } catch (e) {
      setConstraintResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setConstraintLoading(false)
    }
  }, [authHeaders])

  const runRemoveShutterstock = useCallback(async () => {
    if (!confirm('Alle Shutterstock-Bilder (mit Wasserzeichen) aus der Datenbank entfernen? Dieser Vorgang kann nicht rükgängig gemacht werden.')) return
    setShutterstockLoading(true)
    setShutterstockResult(null)
    try {
      const res = await fetch('/api/admin/remove-shutterstock', { method: 'POST', headers: authHeaders() })
      const data = await res.json()
      if (data.ok) {
        setShutterstockResult(`✅ ${data.message}`)
        fetchDbStats()
        fetchImages(1)
      } else {
        setShutterstockResult(`❌ Fehler: ${typeof data.error === 'string' ? data.error : data.error?.message ?? JSON.stringify(data.error)}`)
      }
    } catch (e) {
      setShutterstockResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setShutterstockLoading(false)
    }
  }, [fetchDbStats, fetchImages])

  const runGrayCleanup = useCallback(async () => {
    if (!confirm('Überschüssige Grau/Neutrale Tiles entfernen?\n\nBehält mindestens 5 Tiles pro LAB-Region und reduziert den Grau-Anteil auf ~35%.\n\nDieser Vorgang kann nicht rückgängig gemacht werden.')) return
    setGrayCleanupLoading(true)
    setGrayCleanupResult(null)
    try {
      const res = await fetch('/api/admin/cleanup-gray', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ targetPct: 0.35 }),
      })
      const data = await res.json()
      if (data.ok) {
        setGrayCleanupResult(`✅ ${data.message}`)
        fetchDbStats()
        fetchImages(1)
      } else {
        setGrayCleanupResult(`❌ Fehler: ${typeof data.error === 'string' ? data.error : data.error?.message ?? JSON.stringify(data.error)}`)
      }
    } catch (e) {
      setGrayCleanupResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setGrayCleanupLoading(false)
    }
  }, [fetchDbStats, fetchImages])

  const runPoolOptimize = useCallback(async () => {
    if (poolOptimizeRunning) return
    setPoolOptimizeRunning(true)
    setPoolOptimizeResult(null)
    setPoolImportProgress({ imported: 0, total: 3000, log: ['⏳ Import wird gestartet...'], startedAt: new Date().toISOString(), error: null, report: null })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId: 'pexels', count: 3000, targetPerBucket: 500, jobLabel: 'Pool-Optimierung' }),
      })
      // Poll status with live progress updates
      let done = false
      let attempts = 0
      while (!done && attempts < 180) {
        await new Promise(r => setTimeout(r, 2000))
        attempts++
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: 'pexels', isAnalysis: false }))
          const statusRes = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
          const statusData = await statusRes.json()
          const job = statusData.result?.data ?? statusData
          setPoolImportProgress(prev => ({
            imported: job.imported ?? prev?.imported ?? 0,
            total: job.total ?? prev?.total ?? 3000,
            log: job.log ?? prev?.log ?? [],
            startedAt: job.startedAt ?? prev?.startedAt ?? null,
            error: job.error ?? null,
            report: job.report ?? null,
          }))
          if (!job.running) {
            done = true
            setPoolOptimizeResult(`✅ Pool-Optimierung abgeschlossen: ${job.imported ?? 0} Tiles importiert`)
            fetchDbStats()
            fetchImages(1)
            // Auto-trigger Gemini analysis for newly imported tiles
            if ((job.imported ?? 0) > 0) {
              try {
                const geminiRes = await fetch('/api/admin/ai-analyze-batch', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders() },
                  body: JSON.stringify({ limit: job.imported ?? 500 }),
                })
                const geminiData = await geminiRes.json()
                if (geminiData.started) {
                  setPoolImportProgress(prev => prev ? {
                    ...prev,
                    log: [...prev.log, `🤖 Gemini-Analyse gestartet für ${geminiData.count ?? job.imported} Tiles...`]
                  } : prev)
                }
              } catch { /* Gemini optional */ }
            }
          }
        } catch { /* retry */ }
      }
      if (!done) {
        setPoolOptimizeResult('⏳ Import läuft im Hintergrund weiter...')
      }
    } catch (e) {
      setPoolOptimizeResult(`❌ Fehler: ${String(e)}`)
      setPoolImportProgress(prev => prev ? { ...prev, error: String(e) } : prev)
    } finally {
      setPoolOptimizeRunning(false)
    }
  }, [poolOptimizeRunning, fetchDbStats, fetchImages])

  const runQuickImport = useCallback(async (query: string, label: string) => {
    setQuickImportLoading(query)
    setQuickImportResult(prev => ({ ...prev, [query]: '⏳ Importiere...' }))
    try {
      const res = await fetch('/api/trpc/targetedImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sourceId: 'pexels', query, count: 80 }),
      })
      const data = await res.json()
      if (data.result?.data?.started || data.started) {
        setQuickImportResult(prev => ({ ...prev, [query]: `✅ Import gestartet (bis zu 80 Bilder für "${label}")` }))
        setTimeout(() => { fetchDbStats(); fetchImages(1) }, 8000)
      } else {
        setQuickImportResult(prev => ({ ...prev, [query]: `❌ Fehler: ${data.result?.data?.error ?? 'Unbekannt'}` }))
      }
    } catch (e) {
      setQuickImportResult(prev => ({ ...prev, [query]: `❌ Netzwerkfehler` }))
    } finally {
      setQuickImportLoading(null)
    }
  }, [fetchDbStats, fetchImages])

  useEffect(() => { fetchDbStats() }, [fetchDbStats])
  // Auto-refresh stats every 30s (score updates after imports)
  useEffect(() => {
    const interval = setInterval(() => { fetchDbStats() }, 30000)
    return () => clearInterval(interval)
  }, [fetchDbStats])
  useEffect(() => { setPage(1); fetchImages(1) }, [sourceFilter, colorFilter, brightnessFilter, warmCoolFilter, saturationFilter, geminiFilter, qualityStatusFilter, importedSince, tileTypeFilter])
  useEffect(() => { fetchImages(page) }, [page])

  const handlePdfExport = useCallback(async () => {
    setPdfExporting(true)
    onMessage({ text: 'PDF wird generiert – Bilder werden geladen...', type: 'info' })
    try {
      const { jsPDF } = await import('jspdf')
      // Fetch ALL images via dedicated PDF endpoint (no pagination limit)
      const params: Record<string, string> = {}
      if (sourceFilter !== 'alle') params.sourceId = sourceFilter
      if (colorFilter !== 'alle') params.colorFilter = colorFilter
      if (brightnessFilter !== 'alle') params.brightnessFilter = brightnessFilter
      const encoded = encodeURIComponent(JSON.stringify(params))
      const res = await fetch(`/api/trpc/getAllTilesForPdf?input=${encoded}`, { headers: authHeaders() })
      const data = await res.json()
      const parsed = data.result?.data ?? data
      const allImages: TileImage[] = parsed.images ?? []

      if (allImages.length === 0) {
        onMessage({ text: 'Keine Tiles gefunden für den Export', type: 'error' })
        return
      }

      // Pre-load all images in sequential batches of 8 (browser connection limit)
      const BATCH = 8
      const b64Map = new Map<number, string>()
      for (let i = 0; i < allImages.length; i += BATCH) {
        const batch = allImages.slice(i, i + BATCH)
        const pct = Math.round((i / allImages.length) * 80)
        if (i % 80 === 0) onMessage({ text: `PDF: Lade Bilder... ${pct}% (${i}/${allImages.length})`, type: 'info' })
        await Promise.all(batch.map(async (img) => {
          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 8000)
            const imgRes = await fetch(`/api/tile/${img.id}?size=64`, { headers: authHeaders(), signal: controller.signal })
            clearTimeout(timeout)
            if (!imgRes.ok) return
            const blob = await imgRes.blob()
            const b64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result as string)
              reader.onerror = reject
              reader.readAsDataURL(blob)
            })
            b64Map.set(img.id, b64)
          } catch { /* skip failed images */ }
        }))
      }

      // ── PDF-Splitting-Logik: max. 40 MB pro Datei ────────────────────────────
      // Schätze Tiles pro Teil: 64px JPEG ≈ 8–15 KB encoded → ~12 KB Durchschnitt
      // 40 MB = 40 * 1024 * 1024 Bytes. Wir schätzen konservativ mit 15 KB/Tile.
      const MAX_BYTES = 40 * 1024 * 1024  // 40 MB
      const AVG_TILE_BYTES = 15 * 1024    // 15 KB pro Tile (konservative Schätzung)
      const TILES_PER_PART = Math.floor(MAX_BYTES / AVG_TILE_BYTES)  // ~2730 Tiles

      const totalParts = Math.ceil(allImages.length / TILES_PER_PART)
      const dateStr = new Date().toISOString().slice(0, 10)
      const filterDesc = [sourceFilter !== 'alle' ? `Quelle: ${sourceFilter}` : '', colorFilter !== 'alle' ? `Farbe: ${colorFilter}` : '', brightnessFilter !== 'alle' ? `Helligkeit: ${brightnessFilter}` : ''].filter(Boolean).join(' · ') || 'Alle Tiles'

      const pageW = 210, pageH = 297
      const margin = 10
      const tileSize = 18  // mm per tile
      const gap = 1
      const rowH = tileSize + 10  // tile + label area
      const headerH = 14

      let totalPagesAcrossAllParts = 0

      for (let part = 0; part < totalParts; part++) {
        const partImages = allImages.slice(part * TILES_PER_PART, (part + 1) * TILES_PER_PART)
        const partLabel = totalParts > 1 ? ` (Teil ${part + 1} von ${totalParts})` : ''
        onMessage({ text: `PDF: Erstelle Dokument${partLabel} (${partImages.length} Tiles)...`, type: 'info' })

        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

        // Title page
        doc.setFontSize(20)
        doc.setTextColor(30, 30, 30)
        doc.text(`MosaicPrint – Tile-Katalog${partLabel}`, pageW / 2, 30, { align: 'center' })
        doc.setFontSize(10)
        doc.setTextColor(100, 100, 100)
        doc.text(`${allImages.length.toLocaleString()} Tiles gesamt · ${filterDesc}`, pageW / 2, 42, { align: 'center' })
        doc.text(`Generiert: ${new Date().toLocaleDateString('de-CH')}`, pageW / 2, 50, { align: 'center' })
        doc.text(`Geladen: ${b64Map.size} von ${allImages.length} Bildern`, pageW / 2, 58, { align: 'center' })
        if (totalParts > 1) {
          doc.setFontSize(11)
          doc.setTextColor(60, 60, 60)
          doc.text(`Tiles ${(part * TILES_PER_PART + 1).toLocaleString()} – ${Math.min((part + 1) * TILES_PER_PART, allImages.length).toLocaleString()} von ${allImages.length.toLocaleString()}`, pageW / 2, 68, { align: 'center' })
        }

        // Grid pages
        let x = margin
        let y = headerH + margin
        let pageNum = 1
        doc.addPage()

        const addPageHeader = (pNum: number) => {
          doc.setFontSize(7)
          doc.setTextColor(150, 150, 150)
          const headerText = totalParts > 1
            ? `MosaicPrint Tile-Katalog · Teil ${part + 1}/${totalParts} · Seite ${pNum} · ${partImages.length.toLocaleString()} Tiles`
            : `MosaicPrint Tile-Katalog · Seite ${pNum} · ${allImages.length.toLocaleString()} Tiles`
          doc.text(headerText, margin, 7)
          doc.setDrawColor(220, 220, 220)
          doc.line(margin, 9, pageW - margin, 9)
        }
        addPageHeader(pageNum)

        for (let i = 0; i < partImages.length; i++) {
          const img = partImages[i]
          const b64 = b64Map.get(img.id)
          if (b64) {
            try { doc.addImage(b64, 'JPEG', x, y, tileSize, tileSize) } catch {
              doc.setFillColor(230, 230, 230); doc.rect(x, y, tileSize, tileSize, 'F')
            }
          } else {
            // Placeholder for failed images
            doc.setFillColor(220, 220, 220)
            doc.rect(x, y, tileSize, tileSize, 'F')
            doc.setFontSize(4); doc.setTextColor(150, 150, 150)
            doc.text('?', x + tileSize / 2, y + tileSize / 2, { align: 'center' })
          }

          // Labels below tile
          doc.setFontSize(4.5)
          doc.setTextColor(80, 80, 80)
          const colorLabel = COLOR_LABELS[img.colorCategory ?? '']?.label ?? img.colorCategory ?? ''
          const brightLabel = img.brightnessCategory ?? ''
          doc.text(`#${img.id}`, x + tileSize / 2, y + tileSize + 2.5, { align: 'center' })
          doc.setTextColor(120, 120, 120)
          doc.text(colorLabel, x + tileSize / 2, y + tileSize + 5, { align: 'center' })
          doc.text(`L:${img.avgL.toFixed(0)} a:${img.avgA.toFixed(0)} b:${img.avgB.toFixed(0)}`, x + tileSize / 2, y + tileSize + 7.5, { align: 'center' })
          doc.text(brightLabel, x + tileSize / 2, y + tileSize + 10, { align: 'center' })

          x += tileSize + gap
          if (x + tileSize > pageW - margin) {
            x = margin
            y += rowH
            if (y + rowH > pageH - margin) {
              doc.addPage()
              pageNum++
              addPageHeader(pageNum)
              y = headerH
              x = margin
            }
          }
        }

        totalPagesAcrossAllParts += pageNum

        // Dateiname: bei mehreren Teilen mit "partX-of-Y" Suffix
        const filename = totalParts > 1
          ? `mosaicprint-tiles-${dateStr}-teil${part + 1}-von${totalParts}.pdf`
          : `mosaicprint-tiles-${dateStr}.pdf`

        // Prüfe tatsächliche Dateigröße (jsPDF output als ArrayBuffer)
        const pdfOutput = doc.output('arraybuffer')
        const actualMB = (pdfOutput.byteLength / (1024 * 1024)).toFixed(1)
        onMessage({ text: `PDF Teil ${part + 1}/${totalParts}: ${actualMB} MB – wird heruntergeladen...`, type: 'info' })

        doc.save(filename)

        // Kurze Pause zwischen Downloads damit Browser nicht blockiert
        if (part < totalParts - 1) {
          await new Promise(r => setTimeout(r, 800))
        }
      }

      const summaryParts = totalParts > 1 ? ` in ${totalParts} Dateien` : ''
      onMessage({ text: `✅ PDF mit ${allImages.length} Tiles exportiert (${totalPagesAcrossAllParts} Seiten${summaryParts})`, type: 'success' })
    } catch (e) {
      onMessage({ text: `❌ PDF-Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setPdfExporting(false)
    }
  }, [sourceFilter, colorFilter, brightnessFilter, onMessage])

  const handleDelete = async (id: number) => {
    try {
      await fetch('/api/trpc/deleteMosaicImage', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id })
      })
      setImages(prev => prev.filter(img => img.id !== id))
      setTotal(prev => prev - 1)
      setSelectedImage(null)
      fetchDbStats()
    } catch { onMessage({ text: 'Fehler beim Löschen', type: 'error' }) }
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`${selectedIds.size} Bilder unwiderruflich löschen?`)) return
    setBulkDeleting(true)
    let deleted = 0
    for (const id of Array.from(selectedIds)) {
      try {
        await fetch('/api/trpc/deleteMosaicImage', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ id })
        })
        deleted++
      } catch { /* continue */ }
    }
    setSelectedIds(new Set())
    setBulkDeleting(false)
    onMessage({ text: `✅ ${deleted} Bilder gelöscht`, type: 'success' })
    fetchImages(page)
    fetchDbStats()
  }


  const handleDeleteBySource = async (source: string) => {
    const count = dbStats?.bySource?.[source] ?? 0
    if (!confirm(`Alle ${count.toLocaleString()} ${source}-Tiles unwiderruflich löschen?\n\nDieser Vorgang kann nicht rückgängig gemacht werden!`)) return
    setSourceDeleting(true)
    try {
      const res = await fetch('/api/trpc/deleteBySource', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ source })
      })
      const data = await res.json()
      const deleted = data.result?.data?.json?.deleted ?? data.result?.data?.deleted ?? 0
      onMessage({ text: `✅ ${deleted.toLocaleString()} ${source}-Tiles gelöscht`, type: 'success' })
      setSourceFilter('alle')
      fetchImages(1)
      fetchDbStats()
    } catch (e) {
      onMessage({ text: `❌ Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setSourceDeleting(false)
    }
  }

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-6">
      {/* Statistics Overview */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <button onClick={() => setShowStats(s => !s)} className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors">
          <h2 className="font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-indigo-500" />
            Statistiken & Verteilung
          </h2>
          <span className="text-gray-400 text-sm">{showStats ? '▲ Einklappen' : '▼ Ausklappen'}</span>
        </button>
        {showStats && dbStats && (
          <div className="px-5 pb-6 space-y-6 border-t border-gray-100">
            {/* By Source */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 mt-4">Nach Quelle</h3>
              <div className="flex flex-wrap gap-3">
                {Object.entries(dbStats.bySource ?? {}).map(([src, cnt]) => (
                  <div key={src} className="flex items-center gap-1">
                    <button onClick={() => setSourceFilter(sourceFilter === src ? 'alle' : src)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${sourceFilter === src ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-gray-50 text-gray-700 border-gray-200 hover:border-indigo-300'}`}>
                      {src === 'picsum' ? '📷' : src === 'unsplash' ? '🌄' : src === 'pexels' ? '📸' : '🖼️'}
                      {src} <span className="font-bold">{cnt.toLocaleString()}</span>
                    </button>
                    <button
                      onClick={() => handleDeleteBySource(src)}
                      disabled={sourceDeleting}
                      title={`Alle ${cnt.toLocaleString()} ${src}-Tiles löschen`}
                      className="flex items-center justify-center w-6 h-6 rounded-full bg-red-100 hover:bg-red-200 text-red-600 disabled:opacity-40 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* By Color */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Nach Farbe (LAB-indexiert)</h3>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {Object.entries(COLOR_LABELS).map(([key, { label, color, emoji }]) => {
                  const cnt = (dbStats.byColor ?? {})[key] ?? 0
                  const pct = dbStats.labIndexed > 0 ? Math.round((cnt / dbStats.labIndexed) * 100) : 0
                  return (
                    <button key={key} onClick={() => setColorFilter(colorFilter === key ? 'alle' : key)}
                      className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border transition-all ${colorFilter === key ? 'ring-2 ring-offset-1' : 'hover:border-gray-300'} ${cnt === 0 ? 'opacity-40' : ''}`}
                      style={{ borderColor: colorFilter === key ? color : undefined }}>
                      <span className="text-lg">{emoji}</span>
                      <span className="text-xs font-medium text-gray-700">{label}</span>
                      <span className="text-xs font-bold" style={{ color }}>{cnt.toLocaleString()}</span>
                      <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }} />
                      </div>
                    </button>
                  )
                })}
              </div>
              {/* Missing areas hint */}
              {dbStats.labIndexed > 0 && (() => {
                const missing = Object.entries(COLOR_LABELS)
                  .filter(([key]) => ((dbStats.byColor ?? {})[key] ?? 0) < dbStats.labIndexed * 0.05)
                  .map(([, { label }]) => label)
                if (missing.length === 0) return null
                return (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                    <strong>Unterrepräsentiert (&lt;5%):</strong> {missing.join(', ')} – gezielte Importe empfohlen!
                  </div>
                )
              })()}
            </div>

            {/* By Brightness */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Nach Helligkeit</h3>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'dunkel', label: 'Dunkel', color: '#374151', bg: 'bg-gray-800' },
                  { key: 'mittel', label: 'Mittel', color: '#6b7280', bg: 'bg-gray-400' },
                  { key: 'hell',   label: 'Hell',   color: '#d1d5db', bg: 'bg-gray-200' },
                ].map(({ key, label, color, bg }) => {
                   const cnt = (dbStats.byBrightness ?? {})[key] ?? 0
                   const pct = dbStats.labIndexed > 0 ? Math.round((cnt / dbStats.labIndexed) * 100) : 0
                  return (
                    <button key={key} onClick={() => setBrightnessFilter(brightnessFilter === key ? 'alle' : key)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${brightnessFilter === key ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className={`w-8 h-8 rounded-full ${bg} border border-gray-300`} />
                      <span className="text-sm font-medium text-gray-700">{label}</span>
                      <span className="text-lg font-bold text-gray-900">{cnt.toLocaleString()}</span>
                      <span className="text-xs text-gray-500">{pct}%</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Warm vs. Cool */}
            {dbStats.byWarmCool && (() => {
              const warm = dbStats.byWarmCool!['warm'] ?? 0
              const kuehl = dbStats.byWarmCool!['kuehl'] ?? 0
              const neutral = dbStats.byWarmCool!['neutral'] ?? 0
              const total = warm + kuehl + neutral || 1
              const warmPct = Math.round(warm / total * 100)
              const kuehlPct = Math.round(kuehl / total * 100)
              const neutralPct = Math.round(neutral / total * 100)
              const kuehlOk = kuehlPct >= 20
              return (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Warm vs. Kühl (Farbtemperatur)</h3>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-center cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => { setWarmCoolFilter('warm'); window.scrollTo({ top: 0, behavior: 'smooth' }) }} title="Klick: Warme Tiles in DB anzeigen">
                      <div className="text-2xl mb-1">🔥</div>
                      <div className="text-xs text-gray-500">Warm</div>
                      <div className="text-lg font-bold text-orange-600">{warmPct}%</div>
                      <div className="text-xs text-gray-400">{warm.toLocaleString()}</div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-center cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => { setWarmCoolFilter('neutral'); window.scrollTo({ top: 0, behavior: 'smooth' }) }} title="Klick: Neutrale Tiles in DB anzeigen">
                      <div className="text-2xl mb-1">⚪</div>
                      <div className="text-xs text-gray-500">Neutral</div>
                      <div className="text-lg font-bold text-gray-600">{neutralPct}%</div>
                      <div className="text-xs text-gray-400">{neutral.toLocaleString()}</div>
                    </div>
                    <div className={`rounded-xl p-3 text-center border cursor-pointer hover:opacity-80 transition-opacity ${kuehlOk ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-200'}`}
                      onClick={() => { setWarmCoolFilter('kuehl'); window.scrollTo({ top: 0, behavior: 'smooth' }) }} title="Klick: Kühle Tiles in DB anzeigen">
                      <div className="text-2xl mb-1">❄️</div>
                      <div className="text-xs text-gray-500">Kühl</div>
                      <div className={`text-lg font-bold ${kuehlOk ? 'text-blue-600' : 'text-red-600'}`}>{kuehlPct}%</div>
                      <div className="text-xs text-gray-400">{kuehl.toLocaleString()}</div>
                    </div>
                  </div>
                  {/* Stacked bar */}
                  <div className="h-3 rounded-full overflow-hidden flex">
                    <div className="bg-orange-400 transition-all" style={{ width: `${warmPct}%` }} />
                    <div className="bg-gray-300 transition-all" style={{ width: `${neutralPct}%` }} />
                    <div className="bg-blue-400 transition-all" style={{ width: `${kuehlPct}%` }} />
                  </div>
                  {!kuehlOk && (
                    <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                      ⚠️ <strong>Zu wenig kühle Töne ({kuehlPct}%)</strong> – Ziel: mind. 20%. Import von Blau/Cyan/Violett/Grün empfohlen.
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Extended Brightness 5-Level */}
            {dbStats.byBrightness5 && (() => {
              const levels = [
                { key: 'extrem_dunkel', label: 'Extrem Dunkel', color: '#111827', target: 10 },
                { key: 'dunkel',        label: 'Dunkel',        color: '#374151', target: 20 },
                { key: 'mittel',        label: 'Mittel',        color: '#9ca3af', target: 40 },
                { key: 'hell',          label: 'Hell',          color: '#d1d5db', target: 20 },
                { key: 'extrem_hell',   label: 'Extrem Hell',   color: '#f9fafb', target: 10 },
              ]
              const total5 = levels.reduce((s, l) => s + (dbStats.byBrightness5![l.key] ?? 0), 0) || 1
              const extremeDark = Math.round((dbStats.byBrightness5!['extrem_dunkel'] ?? 0) / total5 * 100)
              const extremeLight = Math.round((dbStats.byBrightness5!['extrem_hell'] ?? 0) / total5 * 100)
              const needsContrast = extremeDark < 10 || extremeLight < 10
              return (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Helligkeit (5 Stufen) – Kontrast-Analyse</h3>
                  <div className="flex gap-2 items-end mb-3" style={{ height: '100px' }}>
                    {levels.map(({ key, label, color, target }) => {
                      const cnt = dbStats.byBrightness5![key] ?? 0
                      const pct = Math.round(cnt / total5 * 100)
                      const ok = pct >= target * 0.7
                      const barHeight = Math.max(8, pct * 1.5)
                      return (
                        <div key={key} className="flex-1 flex flex-col items-center justify-end h-full">
                          <div className="text-xs font-bold mb-1" style={{ color: ok ? '#16a34a' : '#dc2626' }}>{pct}%</div>
                          <div className="w-full rounded-t transition-all" style={{ height: `${barHeight}px`, backgroundColor: color, border: '1px solid #e5e7eb' }} />
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex gap-2 mb-2">
                    {levels.map(({ key, label }) => (
                      <div key={key} className="flex-1 text-center text-xs text-gray-400 leading-tight">{label}</div>
                    ))}
                  </div>
                  {needsContrast && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                      ⚠️ <strong>Kontrast-Lücke:</strong> {extremeDark < 10 ? `Extrem-Dunkel nur ${extremeDark}% (Ziel: 10%)` : ''}{extremeDark < 10 && extremeLight < 10 ? ' · ' : ''}{extremeLight < 10 ? `Extrem-Hell nur ${extremeLight}% (Ziel: 10%)` : ''} – Import von sehr dunklen/hellen Bildern empfohlen.
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Saturation Buckets */}
            {dbStats.bySaturation && (() => {
              const low = dbStats.bySaturation!['niedrig'] ?? 0
              const mid = dbStats.bySaturation!['mittel'] ?? 0
              const high = dbStats.bySaturation!['hoch'] ?? 0
              const totalSat = low + mid + high || 1
              const lowPct = Math.round(low / totalSat * 100)
              const midPct = Math.round(mid / totalSat * 100)
              const highPct = Math.round(high / totalSat * 100)
              const grayPct = dbStats.grayCount ? Math.round(dbStats.grayCount / totalSat * 100) : 0
              const tooHighSat = highPct > 50
              const tooLowNeutral = lowPct < 25
              return (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Sättigung – Qualität für Hauttöne & Übergänge</h3>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: 'Niedrig (glatt)', pct: lowPct, cnt: low, color: 'bg-emerald-100 border-emerald-300', text: 'text-emerald-700', icon: '🌫️', tip: 'Ideal für Hauttöne & Hintergründe', target: 30, satKey: 'niedrig' },
                      { label: 'Mittel', pct: midPct, cnt: mid, color: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700', icon: '🎨', tip: 'Gute Allround-Tiles', target: 40, satKey: 'mittel' },
                      { label: 'Hoch (bunt)', pct: highPct, cnt: high, color: 'bg-pink-50 border-pink-200', text: 'text-pink-700', icon: '🌈', tip: 'Zu viele → Haut wirkt unruhig', target: 30, satKey: 'hoch' },
                    ].map(({ label, pct, cnt, color, text, icon, tip, satKey }) => (
                      <div key={label}
                        className={`rounded-xl p-3 border ${color} cursor-pointer hover:opacity-80 transition-opacity`}
                        onClick={() => { setSaturationFilter(satKey); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                        title={`Klick: ${label}-Tiles in DB anzeigen`}>
                        <div className="text-xl mb-1">{icon}</div>
                        <div className="text-xs font-semibold text-gray-700">{label}</div>
                        <div className={`text-lg font-bold ${text}`}>{pct}%</div>
                        <div className="text-xs text-gray-400">{cnt.toLocaleString()}</div>
                        <div className="text-xs text-gray-500 mt-1 leading-tight">{tip}</div>
                      </div>
                    ))}
                  </div>
                  <div className="h-3 rounded-full overflow-hidden flex">
                    <div className="bg-emerald-400" style={{ width: `${lowPct}%` }} />
                    <div className="bg-yellow-400" style={{ width: `${midPct}%` }} />
                    <div className="bg-pink-400" style={{ width: `${highPct}%` }} />
                  </div>
                  <div className="flex flex-col sm:flex-row sm:justify-between gap-1 text-xs text-gray-400 mt-1">
                    <span>Grau/Neutral: {grayPct}% ({(dbStats.grayCount ?? 0).toLocaleString()} Bilder)</span>
                    <span>Ziel: 30% niedrig · 40% mittel · 30% hoch</span>
                  </div>
                  {(tooHighSat || tooLowNeutral) && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                      ⚠️ {tooHighSat ? `Zu viele hochgesättigte Bilder (${highPct}%) → Haut wirkt unruhig in Portraits. ` : ''}{tooLowNeutral ? `Zu wenig neutrale/desaturierte Bilder (${lowPct}%) → Import von abstrakten Texturen, Grau, Beton, Himmel empfohlen.` : ''}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Tile-Type Distribution */}
            {dbStats.byTileType && (() => {
              const calm = dbStats.byTileType!['calm'] ?? 0
              const medium = dbStats.byTileType!['medium'] ?? 0
              const busy = dbStats.byTileType!['busy'] ?? 0
              const totalTT = calm + medium + busy || 1
              const calmPct = Math.round(calm / totalTT * 100)
              const mediumPct = Math.round(medium / totalTT * 100)
              const busyPct = Math.round(busy / totalTT * 100)
              const tooFewCalm = calmPct < 30
              return (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Tile-Typ – Ruhig / Normal / Komplex</h3>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: '🌫️ Ruhig (calm)', pct: calmPct, cnt: calm, color: 'bg-emerald-100 border-emerald-300', text: 'text-emerald-700', tip: 'Ideal für Haut & Hintergrund', target: 40, type: 'calm' },
                      { label: '🎨 Normal', pct: mediumPct, cnt: medium, color: 'bg-blue-50 border-blue-200', text: 'text-blue-700', tip: 'Allround-Tiles', target: 40, type: 'medium' },
                      { label: '🌀 Komplex (busy)', pct: busyPct, cnt: busy, color: 'bg-orange-50 border-orange-200', text: 'text-orange-700', tip: 'Zu viele → Haut wirkt unruhig', target: 20, type: 'busy' },
                    ].map(({ label, pct, cnt, color, text, tip, type }) => (
                      <div key={label}
                        className={`rounded-xl p-3 border ${color} cursor-pointer hover:opacity-80 transition-opacity`}
                        onClick={() => setTileTypeFilter(type)}>
                        <div className="text-xs font-semibold text-gray-700">{label}</div>
                        <div className={`text-lg font-bold ${text}`}>{pct}%</div>
                        <div className="text-xs text-gray-400">{cnt.toLocaleString()}</div>
                        <div className="text-xs text-gray-500 mt-1 leading-tight">{tip}</div>
                      </div>
                    ))}
                  </div>
                  <div className="h-3 rounded-full overflow-hidden flex">
                    <div className="bg-emerald-400" style={{ width: `${calmPct}%` }} />
                    <div className="bg-blue-400" style={{ width: `${mediumPct}%` }} />
                    <div className="bg-orange-400" style={{ width: `${busyPct}%` }} />
                  </div>
                  <div className="flex flex-col sm:flex-row sm:justify-between gap-1 text-xs text-gray-400 mt-1">
                    <span>Ziel: 40% ruhig · 40% normal · 20% komplex</span>
                    <span className={tooFewCalm ? 'text-amber-600 font-medium' : 'text-gray-400'}>{tooFewCalm ? `⚠️ Zu wenig ruhige Tiles (${calmPct}%)` : '✅ Gute Verteilung'}</span>
                  </div>
                  {tooFewCalm && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                      ⚠️ <strong>Zu wenig ruhige Tiles ({calmPct}%):</strong> Ideal wären 40–50%. Import von Himmel, Nebel, Wasser, Bokeh, Texturen empfohlen. Ziel: {Math.round(totalTT * 0.40 - calm).toLocaleString()} weitere ruhige Tiles.
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={handleBatchReclassify}
                      disabled={rebuildStatus?.running === true}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {rebuildStatus?.running ? '⏳ Läuft...' : '🔄 Alle Tiles neu klassifizieren'}
                    </button>
                    <span className="text-xs text-gray-400">Neuer Score: Sobel-Kanten + Chroma-Varianz + Pixel-Diversität</span>
                  </div>
                  {rebuildStatus?.running && (
                    <div className="mt-2 p-2 bg-violet-50 border border-violet-200 rounded-lg">
                      <div className="flex items-center justify-between text-xs text-violet-700 mb-1">
                        <span>🔄 Reklassifizierung läuft...</span>
                        <span className="text-violet-400">Aktualisiert alle 2s</span>
                      </div>
                      <div className="w-full bg-violet-100 rounded-full h-2 overflow-hidden">
                        <div className="bg-violet-500 h-2 rounded-full animate-pulse" style={{ width: '100%' }} />
                      </div>
                      {rebuildStatus.log.length > 0 && (
                        <div className="mt-1 text-xs text-violet-600 font-mono truncate">{rebuildStatus.log[rebuildStatus.log.length - 1]}</div>
                      )}
                    </div>
                  )}
                  {rebuildStatus && !rebuildStatus.running && rebuildStatus.finishedAt && (
                    <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700">
                      ✅ Reklassifizierung abgeschlossen ({new Date(rebuildStatus.finishedAt).toLocaleTimeString('de-CH')})
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Portrait Quality Score */}
            {dbStats.byWarmCool && dbStats.byBrightness5 && dbStats.bySaturation && (() => {
              const total5 = Object.values(dbStats.byBrightness5!).reduce((a, b) => a + b, 0) || 1
              const totalWC = Object.values(dbStats.byWarmCool!).reduce((a, b) => a + b, 0) || 1
              const totalSat = Object.values(dbStats.bySaturation!).reduce((a, b) => a + b, 0) || 1
              const kuehlPct = Math.round((dbStats.byWarmCool!['kuehl'] ?? 0) / totalWC * 100)
              const extremeDark = Math.round((dbStats.byBrightness5!['extrem_dunkel'] ?? 0) / total5 * 100)
              const extremeLight = Math.round((dbStats.byBrightness5!['extrem_hell'] ?? 0) / total5 * 100)
              const lowSat = Math.round((dbStats.bySaturation!['niedrig'] ?? 0) / totalSat * 100)
              const grayPct = dbStats.grayCount ? Math.round(dbStats.grayCount / totalSat * 100) : 0
              // Score: 0-100 (Portrait-optimiert)
              // Ziele realistisch für Portrait-Mosaics:
              // - Niedrig-Sättigung: 50%+ ideal (glatte Hauttöne, Hintergründe)
              // - Grau/Neutral: 20%+ gut
              // - Kühl: 15%+ (Hintergrund, Schatten)
              // - Extrem Dunkel: 8%+ (Haare, Pupillen)
              // - Extrem Hell: 8%+ (Highlights, Stirn, Schultern)
              let score = 0
              // Niedrig-Sättigung: max 30 pts bei ≥50% (Portrait-Hauptmerkmal)
              score += Math.min(lowSat / 50 * 30, 30)
              // Grau/Neutral: max 20 pts bei ≥20%
              score += Math.min(grayPct / 20 * 20, 20)
              // Kühl: max 20 pts bei ≥15%
              score += Math.min(kuehlPct / 15 * 20, 20)
              // Extrem Dunkel: max 15 pts bei ≥8%
              score += Math.min(extremeDark / 8 * 15, 15)
              // Extrem Hell: max 15 pts bei ≥8%
              score += Math.min(extremeLight / 8 * 15, 15)
              const scoreInt = Math.round(score)
              const scoreColor = scoreInt >= 70 ? 'text-green-600' : scoreInt >= 50 ? 'text-yellow-600' : 'text-red-600'
              const scoreBg = scoreInt >= 70 ? 'bg-green-50 border-green-200' : scoreInt >= 50 ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'
              const scoreLabel = scoreInt >= 70 ? 'Gut – Pool eignet sich gut für Portraits' : scoreInt >= 50 ? 'Mittel – Verbesserungen empfohlen' : 'Schwach – Pool für Portraits nicht optimal'
              return (
                <div className={`rounded-xl border p-4 ${scoreBg}`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-700">🎭 Portrait-Qualitäts-Score</h3>
                    <span className={`text-2xl font-bold ${scoreColor}`}>{scoreInt}/100</span>
                  </div>
                  <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden mb-2">
                    <div className={`h-full rounded-full transition-all ${scoreInt >= 70 ? 'bg-green-500' : scoreInt >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${scoreInt}%` }} />
                  </div>
                  <p className={`text-xs ${scoreColor} font-medium`}>{scoreLabel}</p>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    {[
                      { ok: lowSat >= 50, icon: '🌫️', label: 'Niedrig-Sättigung', value: lowSat, target: 50 },
                      { ok: grayPct >= 20, icon: '⬜', label: 'Grau/Neutral', value: grayPct, target: 20 },
                      { ok: kuehlPct >= 15, icon: '❄️', label: 'Kühl', value: kuehlPct, target: 15 },
                      { ok: extremeDark >= 8, icon: '⚫', label: 'Extrem Dunkel', value: extremeDark, target: 8 },
                      { ok: extremeLight >= 8, icon: '⚪', label: 'Extrem Hell', value: extremeLight, target: 8 },
                    ].map(({ ok, icon, label, value, target }) => (
                      <div key={label} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg ${ok ? 'bg-green-50' : 'bg-amber-50'}`}>
                        <span>{icon}</span>
                        <span className={`flex-1 ${ok ? 'text-green-700' : 'text-amber-700'}`}>
                          {label}: {value}% / {target}% Ziel
                        </span>
                        <span>{ok ? '✅' : <span className="text-amber-600 font-medium">(fehlt {Math.max(0, target - value)}%)</span>}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Pool-Optimierung: One-click actions */}
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">🚀 Pool-Optimierung</h3>
              <p className="text-xs text-gray-500 mb-3">
                Gezielter Import für unterrepräsentierte Farben und Helligkeitsbereiche.
                Nutzt die Lückenanalyse um ~3'000 Tiles in den kritischsten Bereichen zu importieren.
                Inkl. Gradient/Edge-Tiles für Konturerkennung.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={runPoolOptimize}
                  disabled={poolOptimizeRunning}
                  className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
                >
                  {poolOptimizeRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {poolOptimizeRunning ? 'Importiere...' : 'Farblücken füllen (~3\'000 Tiles)'}
                </button>
                <button
                  onClick={runGrayCleanup}
                  disabled={grayCleanupLoading}
                  className="flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
                >
                  {grayCleanupLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  {grayCleanupLoading ? 'Bereinige...' : 'Grau-Überschuss bereinigen'}
                </button>
              </div>

              {/* Live Import Progress Panel */}
              {poolImportProgress && (poolOptimizeRunning || poolImportProgress.report) && (
                <div className="mt-3 bg-white rounded-lg border border-indigo-200 p-3">
                  {/* Progress bar */}
                  <div className="mb-2">
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span className="font-medium">
                        {poolOptimizeRunning ? '⏳ Import läuft...' : '✅ Import abgeschlossen'}
                      </span>
                      <span className="font-mono">{poolImportProgress.imported} / {poolImportProgress.total}</span>
                    </div>
                    <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${poolOptimizeRunning ? 'bg-indigo-500 animate-pulse' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(100, (poolImportProgress.imported / Math.max(1, poolImportProgress.total)) * 100)}%` }}
                      />
                    </div>
                    {poolImportProgress.startedAt && (
                      <div className="text-[10px] text-gray-400 mt-1">
                        Gestartet: {new Date(poolImportProgress.startedAt).toLocaleTimeString('de-CH')}
                        {!poolOptimizeRunning && ` | Dauer: ${poolImportProgress.report?.duration ? `${Math.floor(poolImportProgress.report.duration / 60)}m ${poolImportProgress.report.duration % 60}s` : '—'}`}
                      </div>
                    )}
                  </div>

                  {/* Keyword progress from log */}
                  {poolImportProgress.log.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Keywords & Fortschritt</div>
                      <div className="max-h-48 overflow-y-auto space-y-0.5 text-[11px] font-mono bg-gray-50 rounded p-2 border border-gray-100">
                        {poolImportProgress.log.slice(-30).map((line, i) => {
                          const isSuccess = line.startsWith('✓') || line.startsWith('✅')
                          const isWarning = line.startsWith('⚠️')
                          const isError = line.startsWith('✗') || line.startsWith('❌')
                          const isInfo = line.startsWith('🔍') || line.startsWith('📊') || line.startsWith('🤖')
                          const isRateLimit = line.startsWith('⏳')
                          return (
                            <div key={i} className={`leading-tight ${
                              isSuccess ? 'text-green-700' :
                              isWarning ? 'text-amber-600' :
                              isError ? 'text-red-600' :
                              isInfo ? 'text-indigo-600' :
                              isRateLimit ? 'text-orange-500' :
                              'text-gray-600'
                            }`}>
                              {line}
                            </div>
                          )
                        })}
                        {poolOptimizeRunning && (
                          <div className="text-gray-400 animate-pulse">▌</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Import report summary */}
                  {poolImportProgress.report && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Import-Bericht</div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="bg-green-50 rounded p-1.5 text-center">
                          <div className="font-bold text-green-700">{poolImportProgress.report.imported}</div>
                          <div className="text-green-600 text-[10px]">Importiert</div>
                        </div>
                        <div className="bg-blue-50 rounded p-1.5 text-center">
                          <div className="font-bold text-blue-700">{poolImportProgress.report.totalTilesAfter?.toLocaleString()}</div>
                          <div className="text-blue-600 text-[10px]">Total Tiles</div>
                        </div>
                        <div className="bg-amber-50 rounded p-1.5 text-center">
                          <div className="font-bold text-amber-700">{poolImportProgress.report.keywordStats?.length ?? 0}</div>
                          <div className="text-amber-600 text-[10px]">Keywords</div>
                        </div>
                      </div>
                      {/* Top keywords */}
                      {poolImportProgress.report.topImported?.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[10px] text-gray-500 mb-1">Top Keywords:</div>
                          <div className="flex flex-wrap gap-1">
                            {poolImportProgress.report.topImported.slice(0, 8).map((k: any, i: number) => (
                              <span key={i} className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded-full">
                                {k.query} (+{k.imported})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Error display */}
                  {poolImportProgress.error && (
                    <div className="mt-2 bg-red-50 rounded p-2 text-xs text-red-700">
                      {typeof poolImportProgress.error === 'string' ? poolImportProgress.error : (poolImportProgress.error as any)?.message ?? JSON.stringify(poolImportProgress.error)}
                    </div>
                  )}

                  {/* Close button when done */}
                  {!poolOptimizeRunning && (
                    <button
                      onClick={() => setPoolImportProgress(null)}
                      className="mt-2 text-xs text-gray-400 hover:text-gray-600"
                    >
                      Schliessen
                    </button>
                  )}
                </div>
              )}

              {poolOptimizeResult && !poolOptimizeRunning && !poolImportProgress && (
                <p className={`text-xs mt-2 font-medium ${poolOptimizeResult.startsWith('✅') ? 'text-green-700' : poolOptimizeResult.startsWith('❌') ? 'text-red-700' : 'text-indigo-700'}`}>{poolOptimizeResult}</p>
              )}
              {grayCleanupResult && (
                <p className={`text-xs mt-2 font-medium ${grayCleanupResult.startsWith('✅') ? 'text-green-700' : 'text-red-700'}`}>{grayCleanupResult}</p>
              )}
            </div>

          </div>
        )}
      </div>

      {/* PDF Export + Dedup Button */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-800">🔧 Datenbankwartung</p>
          <p className="text-xs text-amber-600 mt-0.5">Entfernt echte Duplikate (gleiche source_url) – behält jeweils das Bild mit der niedrigsten ID.</p>
          {dedupLoading && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-amber-700 mb-1">
                <span>Bereinige Datenbank...</span>
                <span className="animate-pulse">⏳</span>
              </div>
              <div className="h-2 bg-amber-200 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: '100%' }} />
              </div>
            </div>
          )}
          {dedupProgress && !dedupLoading && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Entfernt: {dedupProgress.deleted.toLocaleString()} Duplikate</span>
                <span>{dedupProgress.after.toLocaleString()} verbleiben</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${Math.round((dedupProgress.after / dedupProgress.before) * 100)}%` }} />
              </div>
              <p className="text-xs text-green-700 mt-1 font-medium">{dedupResult}</p>
            </div>
          )}
          {!dedupProgress && dedupResult && <p className="text-xs mt-1 font-medium text-red-600">{dedupResult}</p>}
          {constraintResult && <p className="text-xs mt-1 font-medium text-gray-700">{constraintResult}</p>}
          {shutterstockResult && <p className="text-xs mt-1 font-medium text-red-700">{shutterstockResult}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={handlePdfExport}
            disabled={pdfExporting}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            {pdfExporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {pdfExporting ? 'PDF wird generiert...' : 'Tile-Katalog als PDF (max. 40 MB/Datei)'}
          </button>
          <button
            onClick={runDedup}
            disabled={dedupLoading}
            className="flex items-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            {dedupLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>🗑️</span>}
            {dedupLoading ? 'Bereinige...' : 'Duplikate entfernen'}
          </button>
          <button
            onClick={runAddConstraint}
            disabled={constraintLoading}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            {constraintLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>🔒</span>}
            {constraintLoading ? 'Setze Constraint...' : 'UNIQUE-Constraint setzen'}
          </button>
          <button
            onClick={runRemoveShutterstock}
            disabled={shutterstockLoading}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            {shutterstockLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>❌</span>}
            {shutterstockLoading ? 'Entferne...' : 'Shutterstock entfernen'}
          </button>
        </div>
      </div>

      {/* Import & Quality Filter Bar */}
      <div className="bg-white rounded-2xl p-4 border border-gray-200 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Import-Zeitraum:</span>
          {['alle', 'last-import', '24h', '7d', '30d'].map(v => (
            <button key={v} onClick={() => { setImportedSince(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                importedSince === v ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {v === 'alle' ? 'Alle' : v === 'last-import' ? '🆕 Letzter Import' : v === '24h' ? 'Letzte 24h' : v === '7d' ? 'Letzte 7 Tage' : 'Letzte 30 Tage'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Qualität:</span>
          {['alle', 'pending', 'pass', 'warn', 'fail'].map(v => (
            <button key={v} onClick={() => { setQualityStatusFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                qualityStatusFilter === v
                  ? v === 'pass' ? 'bg-green-600 text-white'
                  : v === 'warn' ? 'bg-amber-500 text-white'
                  : v === 'fail' ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {v === 'alle' ? 'Alle' : v === 'pending' ? '⏳ Ausstehend' : v === 'pass' ? '✅ Pass' : v === 'warn' ? '⚠️ Warn' : '❌ Fail'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tile-Typ:</span>
          {['alle', 'calm', 'medium', 'busy'].map(v => (
            <button key={v} onClick={() => { setTileTypeFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                tileTypeFilter === v
                  ? v === 'calm' ? 'bg-emerald-600 text-white'
                  : v === 'medium' ? 'bg-blue-600 text-white'
                  : v === 'busy' ? 'bg-orange-600 text-white'
                  : 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {v === 'alle' ? 'Alle' : v === 'calm' ? '🌫️ Ruhig' : v === 'medium' ? '🎨 Normal' : '🌀 Komplex'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Gemini:</span>
          {[{v:'alle',label:'Alle'},{v:'excellent',label:'⭐ Excellent'},{v:'good',label:'👍 Good'},{v:'poor',label:'⚠️ Poor'},{v:'reject',label:'❌ Reject'}].map(({v,label}) => (
            <button key={v} onClick={() => { setGeminiFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                geminiFilter === v
                  ? v === 'excellent' ? 'bg-green-600 text-white'
                  : v === 'good' ? 'bg-blue-600 text-white'
                  : v === 'poor' ? 'bg-amber-500 text-white'
                  : v === 'reject' ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Warm/Kühl:</span>
          {[{v:'alle',label:'Alle'},{v:'warm',label:'🔥 Warm'},{v:'neutral',label:'⚪ Neutral'},{v:'kuehl',label:'❄️ Kühl'}].map(({v,label}) => (
            <button key={v} onClick={() => { setWarmCoolFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                warmCoolFilter === v
                  ? v === 'warm' ? 'bg-orange-500 text-white'
                  : v === 'kuehl' ? 'bg-blue-500 text-white'
                  : v === 'neutral' ? 'bg-gray-500 text-white'
                  : 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Sättigung:</span>
          {[{v:'alle',label:'Alle'},{v:'niedrig',label:'⬜ Niedrig (Hauttöne)'},{v:'mittel',label:'🎨 Mittel'},{v:'hoch',label:'🌈 Hoch (Bunt)'}].map(({v,label}) => (
            <button key={v} onClick={() => { setSaturationFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                saturationFilter === v
                  ? v === 'niedrig' ? 'bg-gray-400 text-white'
                  : v === 'mittel' ? 'bg-purple-500 text-white'
                  : v === 'hoch' ? 'bg-pink-500 text-white'
                  : 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-2xl p-4 border border-gray-200 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-gray-400 shrink-0" />
        <span className="text-sm font-medium text-gray-600">Filter:</span>
        {/* Active filters */}
        {sourceFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2 py-1 rounded-full">
            Quelle: {sourceFilter} <button onClick={() => setSourceFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {colorFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2 py-1 rounded-full">
            Farbe: {COLOR_LABELS[colorFilter]?.label ?? colorFilter} <button onClick={() => setColorFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {brightnessFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2 py-1 rounded-full">
            Helligkeit: {brightnessFilter} <button onClick={() => setBrightnessFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {importedSince !== 'alle' && (
          <span className="flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full">
            Import: {importedSince === '24h' ? 'Letzte 24h' : importedSince === '7d' ? 'Letzte 7 Tage' : importedSince === '30d' ? 'Letzte 30 Tage' : '🆕 Letzter Import'}
            <button onClick={() => setImportedSince('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {qualityStatusFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-amber-100 text-amber-700 text-xs px-2 py-1 rounded-full">
            Qualität: {qualityStatusFilter}
            <button onClick={() => setQualityStatusFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}

        {tileTypeFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-xs px-2 py-1 rounded-full">
            {tileTypeFilter === 'calm' ? '🌫️ Ruhig' : tileTypeFilter === 'medium' ? '🎨 Normal' : '🌀 Komplex'}
            <button onClick={() => setTileTypeFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {warmCoolFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full">
            {warmCoolFilter === 'warm' ? '🔥 Warm' : warmCoolFilter === 'kuehl' ? '❄️ Kühl' : '⚪ Neutral'}
            <button onClick={() => setWarmCoolFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {saturationFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-purple-100 text-purple-700 text-xs px-2 py-1 rounded-full">
            {saturationFilter === 'niedrig' ? '⬜ Niedrig' : saturationFilter === 'mittel' ? '🎨 Mittel' : '🌈 Hoch'}
            <button onClick={() => setSaturationFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {geminiFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-teal-100 text-teal-700 text-xs px-2 py-1 rounded-full">
            Gemini: {geminiFilter === 'excellent' ? '⭐ Excellent' : geminiFilter === 'good' ? '👍 Good' : geminiFilter === 'poor' ? '⚠️ Poor' : '❌ Reject'}
            <button onClick={() => setGeminiFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {(sourceFilter !== 'alle' || colorFilter !== 'alle' || brightnessFilter !== 'alle' || warmCoolFilter !== 'alle' || saturationFilter !== 'alle' || geminiFilter !== 'alle' || importedSince !== 'alle' || qualityStatusFilter !== 'alle'  || tileTypeFilter !== 'alle') && (
          <button onClick={() => { setSourceFilter('alle'); setColorFilter('alle'); setBrightnessFilter('alle'); setWarmCoolFilter('alle'); setSaturationFilter('alle'); setGeminiFilter('alle'); setImportedSince('alle'); setQualityStatusFilter('alle'); setTileTypeFilter('alle') }}
            className="text-xs text-red-500 hover:text-red-700">Alle Filter zurücksetzen</button>
        )}
        <span className="ml-auto text-sm text-gray-500">{total.toLocaleString()} Bilder gefunden</span>
        {selectedIds.size > 0 && (
          <button onClick={handleBulkDelete} disabled={bulkDeleting}
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
            <Trash2 className="w-3 h-3" />
            {bulkDeleting ? 'Lösche...' : `${selectedIds.size} löschen`}
          </button>
        )}
      </div>

      {/* Image Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
        </div>
      ) : images.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>Keine Bilder gefunden</p>
        </div>
      ) : (
        <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-1.5">
          {images.map(img => (
            <div key={img.id} className="relative group aspect-square">
              <button onClick={() => setSelectedImage(img)}
                className={`w-full h-full rounded-lg overflow-hidden border transition-all ${
                  selectedIds.has(img.id) ? 'border-red-500 ring-2 ring-red-400' : 'border-gray-200 hover:border-indigo-400 hover:scale-105'
                }`}>
                <img
                  src={`/api/tile/${img.id}?size=64`}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    const t = e.target as HTMLImageElement;
                    if (!t.dataset.fallback1 && img.tile128Url) {
                      t.dataset.fallback1 = '1';
                      t.src = img.tile128Url;
                    } else if (!t.dataset.fallback2 && img.sourceUrl) {
                      t.dataset.fallback2 = '1';
                      t.src = img.sourceUrl;
                    } else {
                      t.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%23e5e7eb" width="64" height="64"/></svg>';
                    }
                  }}
                />
                {img.colorCategory && COLOR_LABELS[img.colorCategory] && (
                  <div className="absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full border border-white"
                    style={{ backgroundColor: COLOR_LABELS[img.colorCategory].color }} />
                )}
              </button>
              {/* Checkbox for bulk select */}
              <button
                onClick={(e) => { e.stopPropagation(); toggleSelect(img.id) }}
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded border text-xs flex items-center justify-center transition-all ${
                  selectedIds.has(img.id)
                    ? 'bg-red-500 border-red-500 text-white opacity-100'
                    : 'bg-white/80 border-gray-300 opacity-0 group-hover:opacity-100'
                }`}
              >
                {selectedIds.has(img.id) ? '✓' : ''}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="flex items-center gap-1 px-3 py-2 rounded-xl border border-gray-200 text-sm disabled:opacity-40 hover:bg-gray-50">
            <ChevronLeft className="w-4 h-4" /> Zurück
          </button>
          <span className="text-sm text-gray-600">Seite {page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="flex items-center gap-1 px-3 py-2 rounded-xl border border-gray-200 text-sm disabled:opacity-40 hover:bg-gray-50">
            Weiter <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Image Detail Modal */}
      {selectedImage && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setSelectedImage(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <h3 className="font-bold text-gray-900">Bild #{selectedImage.id}</h3>
              <button onClick={() => setSelectedImage(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <img
              src={getHighResUrl(selectedImage.sourceUrl, 600, selectedImage.tile128Url, selectedImage.id)}
              alt=""
              className="w-full aspect-square object-cover rounded-xl mb-4"
              onError={(e) => {
                const t = e.target as HTMLImageElement
                // Fallback chain: tile128Url -> sourceUrl
                if (t.src !== selectedImage.tile128Url && selectedImage.tile128Url) {
                  t.src = selectedImage.tile128Url
                } else if (t.src !== selectedImage.sourceUrl) {
                  t.src = selectedImage.sourceUrl
                }
              }}
            />
            <div className="space-y-1.5 text-sm text-gray-600">
              <div className="flex justify-between"><span>Quelle:</span><span className="font-medium">{selectedImage.sourceId}</span></div>
              {selectedImage.photographerName && (
                <div className="flex justify-between items-center">
                  <span>Fotograf:</span>
                  {selectedImage.photographerUrl ? (
                    <a href={selectedImage.photographerUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline text-xs">
                      {selectedImage.photographerName} (Unsplash)
                    </a>
                  ) : (
                    <span className="font-medium text-xs">{selectedImage.photographerName}</span>
                  )}
                </div>
              )}
              <div className="flex justify-between"><span>Farbe:</span>
                <span className="font-medium flex items-center gap-1">
                  {selectedImage.colorCategory ? (
                    <><span>{COLOR_LABELS[selectedImage.colorCategory]?.emoji}</span> {COLOR_LABELS[selectedImage.colorCategory]?.label ?? selectedImage.colorCategory}</>
                  ) : 'Nicht indexiert'}
                </span>
              </div>
              <div className="flex justify-between"><span>Helligkeit:</span><span className="font-medium">{selectedImage.brightnessCategory ?? 'Nicht indexiert'}</span></div>
              <div className="flex justify-between"><span>Sättigung:</span><span className="font-medium">{selectedImage.saturationCategory ?? '–'}</span></div>
              <div className="flex justify-between"><span>Warm/Kühl:</span><span className="font-medium">{selectedImage.warmCoolCategory ?? '–'}</span></div>
              <div className="flex justify-between"><span>Tile-Typ:</span><span className="font-medium">{selectedImage.tileType ?? '–'}</span></div>
              <div className="flex justify-between"><span>Thema:</span><span className="font-medium">{selectedImage.subject ?? 'general'}</span></div>
              {/* Qualitäts-Metriken */}
              <div className="mt-2 pt-2 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 mb-1">Qualitäts-Metriken</p>
                <div className="grid grid-cols-1 gap-0.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Mosaic-Score:</span>
                    <span className={selectedImage.aiMosaicScore != null ? (selectedImage.aiMosaicScore >= 70 ? 'text-green-600 font-bold' : selectedImage.aiMosaicScore >= 40 ? 'text-yellow-600' : 'text-red-500') : 'text-gray-400'}>
                      {selectedImage.aiMosaicScore != null ? `${selectedImage.aiMosaicScore}/100` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Gemini:</span>
                    <span className={selectedImage.geminiStatus === 'approved' ? 'text-green-600' : selectedImage.geminiStatus === 'rejected' ? 'text-red-500' : 'text-gray-400'}>
                      {selectedImage.geminiStatus === 'approved' ? `✅ Exzellent${selectedImage.geminiScore != null ? ` (${Math.round(selectedImage.geminiScore * 100)}%)` : ''}` :
                       selectedImage.geminiStatus === 'rejected' ? `❌ Abgelehnt${selectedImage.geminiScore != null ? ` (${Math.round(selectedImage.geminiScore * 100)}%)` : ''}` :
                       selectedImage.geminiScore != null ? `⏳ ${Math.round(selectedImage.geminiScore * 100)}%` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Schärfe (Blur):</span>
                    <span className={selectedImage.blurScore != null
                      ? (selectedImage.blurScore >= 50 ? 'text-green-600' : selectedImage.blurScore >= 20 ? 'text-yellow-600' : 'text-red-500')
                      : 'text-gray-400'}>
                      {selectedImage.blurScore != null
                        ? `${selectedImage.blurScore.toFixed(1)} ${selectedImage.blurScore >= 50 ? '(scharf)' : selectedImage.blurScore >= 20 ? '(mittel)' : '(unscharf)'}`
                        : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Kantendichte:</span>
                    {/* edge_energy is Sobel-normalized 0-1 (64x64). Display as % of max (0.15 = typical busy image). */}
                    <span className={selectedImage.edgeEnergy != null
                      ? (selectedImage.edgeEnergy >= 0.10 ? 'text-orange-600' : selectedImage.edgeEnergy >= 0.04 ? 'text-green-600' : 'text-blue-500')
                      : ''}>
                      {selectedImage.edgeEnergy != null
                        ? `${(selectedImage.edgeEnergy * 100).toFixed(2)}% ${selectedImage.edgeEnergy >= 0.10 ? '(busy)' : selectedImage.edgeEnergy >= 0.04 ? '(mittel)' : '(ruhig)'}`
                        : '–'}
                    </span>
                  </div>
                  {selectedImage.importQuery && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">Import-Query:</span>
                      <span className="text-indigo-500 truncate max-w-32">{selectedImage.importQuery}</span>
                    </div>
                  )}
                </div>
              </div>
              {/* 15D LAB Feature Vectors */}
              <div className="mt-2 pt-2 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 mb-1">15D Matching-Features</p>
                <div className="grid grid-cols-1 gap-0.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Global L,a,b:</span>
                    <span>{selectedImage.avgL.toFixed(1)}, {selectedImage.avgA.toFixed(1)}, {selectedImage.avgB.toFixed(1)}</span>
                  </div>
                  {(selectedImage.tlA !== undefined && selectedImage.tlA !== 0) || (selectedImage.tlB !== undefined && selectedImage.tlB !== 0) ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-400">TL L,a,b:</span>
                        <span>{(selectedImage.tlL ?? 0).toFixed(1)}, {(selectedImage.tlA ?? 0).toFixed(1)}, {(selectedImage.tlB ?? 0).toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">TR L,a,b:</span>
                        <span>{(selectedImage.trL ?? 0).toFixed(1)}, {(selectedImage.trA ?? 0).toFixed(1)}, {(selectedImage.trB ?? 0).toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">BL L,a,b:</span>
                        <span>{(selectedImage.blL ?? 0).toFixed(1)}, {(selectedImage.blA ?? 0).toFixed(1)}, {(selectedImage.blB ?? 0).toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">BR L,a,b:</span>
                        <span>{(selectedImage.brL ?? 0).toFixed(1)}, {(selectedImage.brA ?? 0).toFixed(1)}, {(selectedImage.brB ?? 0).toFixed(1)}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-red-500 text-xs">⚠️ Quadrant-LAB fehlt – Backfill nötig!</p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <a href={selectedImage.sourceUrl} target="_blank" rel="noopener noreferrer" className="flex-1 text-center text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-4 py-2 rounded-xl transition-colors">Öffnen</a>
              <button onClick={() => handleDelete(selectedImage.id)} className="flex items-center gap-2 text-sm bg-red-50 hover:bg-red-100 text-red-600 font-medium px-4 py-2 rounded-xl transition-colors">
                <Trash2 className="w-4 h-4" /> Löschen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Algorithm Settings ────────────────────────────────────────────────────────
// ── Category Profiles Panel ─────────────────────────────────────────────────
function CategoryProfilesPanel() {
  const { authHeaders } = useAuth();
  const [categories, setCategories] = useState<Array<{
    name: string; label: string; parent_category: string;
    keywords: string[]; algo_settings: Record<string, unknown>;
    description: string; updated_at?: string;
  }>>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const loadCategories = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/trpc/getImageCategories', { headers: authHeaders() })
      const data = await res.json()
      const cats = data?.result?.data?.json ?? data?.result?.data ?? []
      setCategories(cats.filter((c: {algo_settings: Record<string,unknown>}) =>
        c.algo_settings && Object.keys(c.algo_settings).length > 0
      ))
    } catch { /* ignore */ } finally { setLoading(false) }
  }

  useEffect(() => { if (open) loadCategories() }, [open])

  const deleteProfile = async (catName: string) => {
    if (!confirm(`Profil für "${catName}" löschen?`)) return
    try {
      await fetch('/api/trpc/saveImageCategoryAlgoSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ categoryName: catName, settings: {} })
      })
      loadCategories()
    } catch { /* ignore */ }
  }

  const applyProfile = (settings: Record<string, unknown>) => {
    try {
      const existing = JSON.parse(localStorage.getItem('mosaicSettings') ?? '{}')
      localStorage.setItem('mosaicSettings', JSON.stringify({ ...existing, ...settings }))
      window.dispatchEvent(new Event('mosaicSettingsChanged'))
      alert('✅ Profil angewendet! Lade die Studio-Seite neu um die Änderungen zu sehen.')
    } catch { /* ignore */ }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">📋</span>
          <div className="text-left">
            <h3 className="font-semibold text-gray-800">Gespeicherte Kategorie-Profile</h3>
            <p className="text-xs text-gray-500">Algorithmus-Einstellungen pro Bildkategorie (Portrait, Landschaft, etc.)</p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲ Einklappen' : '▼ Anzeigen'}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-5">
          {loading && <p className="text-sm text-gray-400 text-center py-4">⏳ Lade Profile...</p>}
          {!loading && categories.length === 0 && (
            <div className="text-center py-6">
              <p className="text-gray-400 text-sm">Noch keine Profile gespeichert.</p>
              <p className="text-gray-400 text-xs mt-1">Analysiere ein Testbild in der Qualitätssicherung und speichere das Algorithmus-Profil.</p>
            </div>
          )}
          {!loading && categories.length > 0 && (
            <div className="space-y-3">
              {categories.map(cat => (
                <div key={cat.name} className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between p-3 bg-gray-50">
                    <div>
                      <span className="font-semibold text-gray-800 text-sm">{cat.label}</span>
                      <span className="ml-2 text-xs text-gray-400 capitalize">{cat.parent_category}</span>
                      {cat.updated_at && (
                        <span className="ml-2 text-xs text-gray-400">
                          · gespeichert {new Date(cat.updated_at).toLocaleDateString('de-CH')}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => applyProfile(cat.algo_settings)}
                        className="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-2 py-1 rounded-lg transition-colors"
                      >
                        ▶ Anwenden
                      </button>
                      <button
                        onClick={() => setExpanded(expanded === cat.name ? null : cat.name)}
                        className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-1 rounded-lg transition-colors"
                      >
                        {expanded === cat.name ? '▲ Details' : '▼ Details'}
                      </button>
                      <button
                        onClick={() => deleteProfile(cat.name)}
                        className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-2 py-1 rounded-lg transition-colors"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  {expanded === cat.name && (
                    <div className="p-3 bg-gray-900 text-green-400 font-mono text-xs">
                      <pre>{JSON.stringify(cat.algo_settings, null, 2)}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Profile Popup ─────────────────────────────────────────────────────────────
function ProfilePopup({ profile, onClose, onApply }: {
  profile: Profile
  onClose: () => void
  onApply: (settings: Partial<AlgoSettings>) => void
}) {
  const { authHeaders } = useAuth();
  const [editedSettings, setEditedSettings] = useState<Partial<AlgoSettings>>({ ...profile.settings })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const updateSetting = (key: keyof AlgoSettings, value: number | string | boolean) => {
    setEditedSettings(prev => ({ ...prev, [key]: value }))
  }

  const handleApply = () => {
    onApply(editedSettings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSaveToDb = async () => {
    setSaving(true)
    try {
      await fetch('/api/trpc/saveImageCategoryAlgoSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ categoryName: profile.id, settings: editedSettings })
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const numField = (key: keyof AlgoSettings, label: string, min: number, max: number, step: number, fmt?: (v: number) => string) => {
    const val = editedSettings[key] as number ?? 0
    return (
      <div key={key} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
        <div className="w-40 shrink-0">
          <div className="text-xs font-medium text-gray-700">{label}</div>
        </div>
        <input type="range" min={min} max={max} step={step} value={val}
          onChange={e => updateSetting(key, Number(e.target.value))}
          className="flex-1 accent-indigo-600 h-1.5" />
        <span className="w-14 text-right font-mono text-xs font-bold text-indigo-700">
          {fmt ? fmt(val) : val}
        </span>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{profile.icon}</span>
            <div>
              <h3 className="font-bold text-gray-900">{profile.label}</h3>
              <p className="text-xs text-gray-500">{profile.description}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-1">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Kachel-Raster</p>
          {numField('baseTiles', 'Anzahl Kacheln', 20, 150, 1)}
          {numField('tilePx', 'Kachel-Grösse (px)', 4, 32, 1)}
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-4">Matching-Gewichte</p>
          {numField('brightnessWeight', 'Helligkeit', 0, 1, 0.05, v => (v*100).toFixed(0)+'%')}
          {numField('labWeight', 'LAB-Farbe', 0, 1, 0.05, v => (v*100).toFixed(0)+'%')}
          {numField('textureWeight', 'Textur', 0, 1, 0.05, v => (v*100).toFixed(0)+'%')}
          {numField('edgeWeight', 'Kanten', 0, 1, 0.05, v => (v*100).toFixed(0)+'%')}
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-4">Farb-Korrektur</p>
          {numField('contrastBoost', 'Kontrast-Boost', 1.0, 1.8, 0.05, v => v.toFixed(2)+'×')}
          {numField('histogramBlend', 'Farb-Transfer', 0, 0.15, 0.01, v => Math.round(v*650)+'%')}
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-4">Farb-Overlay</p>
          {numField('baseOverlay', 'Basis-Overlay', 0, 0.5, 0.01, v => Math.round(v*100)+'%')}
          {numField('edgeBoost', 'Kanten-Boost', 0, 0.5, 0.01, v => Math.round(v*100)+'%')}
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-4">Anti-Repetition</p>
          {numField('neighborRadius', 'Radius', 1, 20, 1)}
          {numField('neighborPenalty', 'Penalty', 0, 600, 10)}
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-xs font-medium text-gray-700">Overlay-Modus</span>
            <div className="flex gap-1">
              {(['none', 'softlight', 'alpha'] as const).map(mode => (
                <button key={mode} onClick={() => updateSetting('overlayMode', mode)}
                  className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                    editedSettings.overlayMode === mode ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {mode === 'none' ? 'Kein' : mode === 'softlight' ? 'Soft' : 'Alpha'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-xs font-medium text-gray-700">Kachel-Rotation</span>
            <button onClick={() => updateSetting('enableRotation', !editedSettings.enableRotation)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${editedSettings.enableRotation ? 'bg-indigo-600' : 'bg-gray-200'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${editedSettings.enableRotation ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>
        <div className="p-5 border-t border-gray-100 flex gap-3">
          <button onClick={handleApply}
            className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition-colors">
            <Zap className="w-4 h-4" />
            {saved ? 'Angewendet ✓' : 'Jetzt anwenden'}
          </button>
          <button onClick={handleSaveToDb} disabled={saving}
            className="flex items-center gap-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-medium px-4 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-50">
            <Save className="w-4 h-4" />
            {saving ? 'Speichert...' : 'In DB speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AlgorithmSettings() {
  const [settings, setSettings] = useState<AlgoSettings>(loadSettings)
  const [saved, setSaved] = useState(false)
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)

  const update = (key: keyof AlgoSettings, value: number | string | boolean) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = () => {
    saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleReset = () => {
    setSettings({ ...DEFAULT_SETTINGS })
    saveSettings({ ...DEFAULT_SETTINGS })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  const applyProfileSettings = (profileSettings: Partial<AlgoSettings>) => {
    const merged = { ...settings, ...profileSettings }
    setSettings(merged)
    saveSettings(merged)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    setActiveProfile(null)
  }

  type NumericSettingKey = { [K in keyof AlgoSettings]: AlgoSettings[K] extends number ? K : never }[keyof AlgoSettings];
  const SliderRow = ({ label, desc, settingKey, min, max, step = 1, format = (v: number) => String(v) }: {
    label: string; desc: string; settingKey: NumericSettingKey
    min: number; max: number; step?: number; format?: (v: number) => string
  }) => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 py-3 border-b border-gray-100 last:border-0">
      <div className="sm:w-64 shrink-0">
        <div className="font-medium text-sm text-gray-900">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{desc}</div>
      </div>
      <div className="flex-1 flex items-center gap-3">
        <input type="range" min={min} max={max} step={step} value={settings[settingKey]}
          onChange={e => update(settingKey, Number(e.target.value))}
          className="flex-1 accent-indigo-600" />
        <span className="w-16 text-right font-mono text-sm font-bold text-indigo-700">{format(settings[settingKey] as number)}</span>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Profile Popup */}
      {activeProfile && (
        <ProfilePopup
          profile={activeProfile}
          onClose={() => setActiveProfile(null)}
          onApply={applyProfileSettings}
        />
      )}
      {/* Preset Profile Buttons */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
          <span className="text-lg">🎯</span> Schnell-Profile
        </h2>
        <p className="text-sm text-gray-500 mb-4">Klicke auf ein Profil um die Einstellungen zu sehen und anzupassen. Änderungen werden sofort im Studio angewendet.</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {PRESET_PROFILES.map(profile => {
            // Quality badge based on profile type
            const QUALITY: Record<string, { score: string; color: string }> = {
              portrait: { score: '9.2/10', color: 'bg-rose-100 text-rose-700' },
              landscape: { score: '9.0/10', color: 'bg-green-100 text-green-700' },
              night: { score: '9.1/10', color: 'bg-indigo-100 text-indigo-700' },
              colorful: { score: '9.0/10', color: 'bg-pink-100 text-pink-700' },
              highres: { score: '9.3/10', color: 'bg-blue-100 text-blue-700' },
              portrait_dark: { score: '9.0/10', color: 'bg-orange-100 text-orange-700' },
              white_hair: { score: '8.9/10', color: 'bg-gray-100 text-gray-700' },
              minimal: { score: '8.8/10', color: 'bg-slate-100 text-slate-700' },
              abstract_art: { score: '9.1/10', color: 'bg-purple-100 text-purple-700' },
            }
            const q = QUALITY[profile.id]
            return (
              <button
                key={profile.id}
                onClick={() => setActiveProfile(profile)}
                className="flex flex-col items-center gap-2 p-3 rounded-xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all group relative"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">{profile.icon}</span>
                <span className="text-xs font-semibold text-gray-700 group-hover:text-indigo-700 text-center leading-tight">{profile.label}</span>
                {q && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${q.color}`}>{q.score}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100">
          <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-1">
            <Settings className="w-5 h-5 text-indigo-500" />
            Algorithmus-Parameter (Feintuning)
          </h2>
          <p className="text-sm text-gray-500">Diese Werte steuern den Mosaic-Algorithmus im Studio. Änderungen werden sofort beim nächsten Mosaik-Rendering angewendet.</p>
        </div>

        <div className="p-6 space-y-1">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Kachel-Raster</h3>
          <SliderRow label="Anzahl Kacheln (Basis)" desc="Kacheln entlang der längsten Seite. Mehr = feiner = besser erkennbar. Empfohlen: 100." settingKey="baseTiles" min={20} max={150} />
          <SliderRow label="Kachel-Grösse (px)" desc="Pixel pro Kachel im Vorschau-Canvas. Kleiner = mehr Kacheln sichtbar, schärferes Mosaik." settingKey="tilePx" min={4} max={32} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Farb-Overlay</h3>
          <SliderRow label="Basis-Overlay" desc="Grundstärke des Farb-Overlays. Höher = Gesamtbild besser erkennbar." settingKey="baseOverlay" min={0} max={0.5} step={0.01} format={v => (v * 100).toFixed(0) + '%'} />
          <SliderRow label="Kanten-Boost" desc="Zusätzlicher Overlay an Kanten/Konturen. Höher = schärfere Konturen." settingKey="edgeBoost" min={0} max={0.5} step={0.01} format={v => (v * 100).toFixed(0) + '%'} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Anti-Repetition</h3>
          <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
            ⚠️ <strong>Hinweis:</strong> Bei Portrait-Bildern werden Nachbar-Radius und Nachbar-Penalty durch das Portrait-Preset überschrieben (aktuell: Radius 6, Penalty 400). Änderungen hier wirken nur bei Nicht-Portrait-Bildern.
          </div>
          <SliderRow label="Nachbar-Radius" desc="Wie viele Kacheln um eine Kachel herum auf Wiederholung geprüft werden. Bei Portraits: durch Preset gesperrt (6)." settingKey="neighborRadius" min={1} max={10} />
          <SliderRow label="Nachbar-Penalty" desc="Stärke der Bestrafung für wiederholte Kacheln in der Nähe. Höher = mehr Vielfalt. Bei Portraits: durch Preset gesperrt (400)." settingKey="neighborPenalty" min={0} max={600} step={10} />
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Mobile-Optimierung</h3>
          <SliderRow label="Mobile Max Tiles" desc="Maximale Anzahl einzigartiger Kacheln auf Mobilgeräten. Höher = bessere Qualität, mehr RAM-Verbrauch. Empfohlen: 1500–5000. Bis 10000 für Tests möglich." settingKey="mobileMaxTiles" min={500} max={10000} step={500} />
          <SliderRow label="Blur-Overlay Opacity" desc="Stärke des 1px-Blur-Überlagerungseffekts auf Kachel-Rändern. 0% = aus, 8% = subtil (Standard), 20-30% = sichtbar weicher. Nur im Modus 'none' aktiv." settingKey="blurOpacity" min={0} max={0.30} step={0.01} format={v => Math.round(v * 100) + '%'} />
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Hi-Res Zoom</h3>
          <SliderRow label="Hi-Res Kachel-Grösse (px)" desc="Auflösung der Kacheln beim Zoom. Höher = schärfer, aber langsamer zu laden." settingKey="hiResPx" min={80} max={400} step={20} />
          <SliderRow label="Hi-Res Schwellwert" desc="Ab welchem Zoom-Level die Hi-Res-Kacheln eingeblendet werden." settingKey="hiResThreshold" min={0.5} max={3} step={0.1} format={v => v.toFixed(1) + '×'} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Matching-Gewichte</h3>
          <SliderRow label="LAB-Farbe" desc="Gewichtung der globalen LAB-Farbdistanz beim Matching." settingKey="labWeight" min={0} max={1} step={0.05} format={v => (v * 100).toFixed(0) + '%'} />
          <SliderRow label="Helligkeit" desc="Gewichtung des Helligkeitsunterschieds beim Matching." settingKey="brightnessWeight" min={0} max={1} step={0.05} format={v => (v * 100).toFixed(0) + '%'} />
          <SliderRow label="Textur" desc="Gewichtung der Textur-Ähnlichkeit beim Matching." settingKey="textureWeight" min={0} max={1} step={0.05} format={v => (v * 100).toFixed(0) + '%'} />
          <SliderRow label="Kanten-Energie" desc="Gewichtung der Kanten-Energie beim Matching." settingKey="edgeWeight" min={0} max={1} step={0.05} format={v => (v * 100).toFixed(0) + '%'} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Farb-Korrektur</h3>
          <SliderRow label="Kontrast-Boost" desc="Kontrast des Zielbilds vor dem Matching. 1.0=kein Boost, 1.3=30% mehr Kontrast." settingKey="contrastBoost" min={1.0} max={1.8} step={0.05} format={v => v.toFixed(2) + '×'} />
          <SliderRow label="Farb-Transfer" desc="Wie stark jede Kachel farblich an die Zielzelle angepasst wird (LAB Color Transfer). 0=aus, 0.10=65% (empfohlen), 0.15=100%." settingKey="histogramBlend" min={0} max={0.15} step={0.01} format={v => Math.round(v * 650) + '%'} />

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 py-3 border-b border-gray-100">
            <div className="sm:w-64 shrink-0">
              <div className="font-medium text-sm text-gray-900">Overlay-Modus</div>
              <div className="text-xs text-gray-500 mt-0.5">Wie das Farb-Overlay auf die Kacheln angewendet wird. "Kein" = reinste Fotos.</div>
            </div>
            <div className="flex gap-2">
              {(['none', 'softlight', 'alpha'] as const).map(mode => (
                <button key={mode} onClick={() => update('overlayMode', mode)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    settings.overlayMode === mode ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {mode === 'none' ? 'Kein Overlay' : mode === 'softlight' ? 'Soft-Light' : 'Alpha-Blend'}
                </button>
              ))}
            </div>
          </div>

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Kachel-Optionen</h3>
          <div className="flex items-center justify-between py-3 border-b border-gray-100">
            <div>
              <div className="text-sm font-medium text-gray-800">Kachel-Rotation</div>
              <div className="text-xs text-gray-400 mt-0.5">Kacheln werden in 0°/90°/180°/270° gedreht für besseres Farbmatching.</div>
            </div>
            <button
              onClick={() => update('enableRotation', !settings.enableRotation)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.enableRotation ? 'bg-indigo-600' : 'bg-gray-200'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                settings.enableRotation ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>

        <div className="p-6 border-t border-gray-100 flex items-center gap-3">
          <button onClick={handleSave} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm">
            <Save className="w-4 h-4" />
            {saved ? 'Gespeichert ✓' : 'Einstellungen speichern'}
          </button>
          <button onClick={handleReset} className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-4 py-2.5 rounded-xl transition-colors text-sm">
            <RefreshCw className="w-4 h-4" />
            Zurücksetzen
          </button>
          <span className="text-xs text-gray-400 ml-2">Einstellungen werden im Browser gespeichert und beim nächsten Mosaik angewendet.</span>
        </div>
      </div>

      {/* Current values preview */}
      <div className="bg-gray-900 rounded-2xl p-5 text-green-400 font-mono text-xs">
        <div className="text-gray-400 mb-2">// Aktuelle Werte (werden in Studio.tsx gelesen)</div>
        <pre>{JSON.stringify(settings, null, 2)}</pre>
      </div>

      {/* Kategorie-Profile-Übersicht */}
      <CategoryProfilesPanel />
    </div>
  )
}

// ── Last Mosaic Quality Panel ────────────────────────────────────────────────
// ── Gemini Analysis Panel (Admin-only) ────────────────────────────────────────
// Shows the last Gemini image analysis and the dynamically applied settings
function GeminiAnalysisPanel() {
  const [analysis, setAnalysis] = useState<Record<string, any> | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem('mosaicprint_gemini_analysis')
        if (raw) setAnalysis(JSON.parse(raw))
      } catch { /* ignore */ }
    }
    load()
    window.addEventListener('geminiAnalysisUpdated', load)
    window.addEventListener('storage', load)
    return () => { window.removeEventListener('geminiAnalysisUpdated', load); window.removeEventListener('storage', load) }
  }, [])

  if (!analysis) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2"><span>🤖</span> Gemini Bildanalyse & Dynamische Einstellungen</h3>
        <p className="text-sm text-gray-400 mt-2">Noch keine Analyse vorhanden. Lade ein Bild im Studio hoch – die Gemini-Analyse und die dynamisch angepassten Einstellungen erscheinen hier.</p>
      </div>
    )
  }

  const attrs = analysis.attributes as Record<string, any> | undefined
  const regions = analysis.regions as Record<string, Record<string, any>> | undefined
  const dynamic = analysis.dynamicSettings as Record<string, any> | undefined
  const applied = analysis.appliedSettings as Record<string, any> | undefined
  const algo = analysis.algoRecommendations as Record<string, any> | undefined
  const ts = analysis.timestamp ? new Date(analysis.timestamp as string).toLocaleString('de-CH') : ''

  // Setting labels for display
  const settingLabels: Record<string, string> = {
    baseTiles: 'Spalten (baseTiles)',
    tilePx: 'Kachelgrösse (px)',
    maxReuse: 'Max. Wiederverwendung',
    rotation: 'Rotation',
    neighborRadius: 'Anti-Repetition Radius',
    neighborPenalty: 'Anti-Repetition Penalty',
    contrastBoost: 'Kontrast-Boost',
    histogramBlend: 'Histogram-Blend',
    baseOverlay: 'Overlay-Basis',
    edgeBoost: 'Kanten-Boost',
    overlayMode: 'Overlay-Modus',
    labWeight: 'Farbe (LAB)',
    brightnessWeight: 'Helligkeit (L)',
    textureWeight: 'Textur',
    edgeWeight: 'Kanten',
    saturationWeight: 'Sättigung',
    portraitMode: 'Portrait-Modus',
    tileComplexityThreshold: 'Tile-Komplexität Max',
  }

  const regionColors: Record<string, string> = {
    face: 'bg-rose-100 text-rose-700 border-rose-200',
    hair: 'bg-amber-100 text-amber-700 border-amber-200',
    clothing: 'bg-blue-100 text-blue-700 border-blue-200',
    background: 'bg-gray-100 text-gray-700 border-gray-200',
    other: 'bg-purple-100 text-purple-700 border-purple-200',
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-bold text-gray-900 flex items-center gap-2"><span>🤖</span> Gemini Bildanalyse & Dynamische Einstellungen</h3>
          <p className="text-sm text-gray-500 mt-0.5">Letzte Analyse: {ts}</p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {expanded ? 'Einklappen' : 'Details anzeigen'}
        </button>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-indigo-50 rounded-xl p-3 text-center">
          <p className="text-xs text-indigo-500 font-medium">Szene</p>
          <p className="text-sm font-bold text-indigo-800 mt-0.5">{String(analysis.sceneType ?? '–')}</p>
        </div>
        <div className="bg-rose-50 rounded-xl p-3 text-center">
          <p className="text-xs text-rose-500 font-medium">Gesichter</p>
          <p className="text-sm font-bold text-rose-800 mt-0.5">{analysis.hasFace ? `Ja (${analysis.faceCount ?? 1})` : 'Nein'}</p>
        </div>
        <div className="bg-amber-50 rounded-xl p-3 text-center">
          <p className="text-xs text-amber-500 font-medium">Hautton</p>
          <p className="text-sm font-bold text-amber-800 mt-0.5">{String(attrs?.skinTone ?? '–')}</p>
        </div>
        <div className="bg-emerald-50 rounded-xl p-3 text-center">
          <p className="text-xs text-emerald-500 font-medium">Haarfarbe</p>
          <p className="text-sm font-bold text-emerald-800 mt-0.5">{String(attrs?.hairColor ?? '–')}</p>
        </div>
      </div>

      {/* Description */}
      {analysis.description && (
        <p className="text-sm text-gray-600 italic mb-4 px-1">"{String(analysis.description)}"</p>
      )}

      {expanded && (
        <div className="space-y-4 mt-4 border-t border-gray-100 pt-4">
          {/* Regions */}
          {regions && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Bildregionen</h4>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {Object.entries(regions).map(([key, region]) => (
                  <div key={key} className={`rounded-xl border p-3 ${regionColors[key] ?? 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                    <p className="text-xs font-semibold capitalize">{key === 'face' ? 'Gesicht' : key === 'hair' ? 'Haare' : key === 'clothing' ? 'Kleidung' : key === 'background' ? 'Hintergrund' : 'Sonstiges'}</p>
                    <p className="text-lg font-bold mt-0.5">{region?.pct ?? 0}%</p>
                    {region?.dominantColor && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <div className="w-4 h-4 rounded-full border border-black/10" style={{ backgroundColor: String(region.dominantColor) }} />
                        <span className="text-xs font-mono">{String(region.dominantColor)}</span>
                      </div>
                    )}
                    <p className="text-xs mt-1 opacity-70">Komplexität max: {region?.tileComplexityMax ?? '–'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Algo Reasoning */}
          {(dynamic?.reasoning || algo?.reasoning) && (
            <div className="bg-indigo-50 rounded-xl p-3 border border-indigo-200">
              <p className="text-xs font-semibold text-indigo-600 mb-1">KI-Begründung</p>
              <p className="text-sm text-indigo-800">{String(dynamic?.reasoning ?? algo?.reasoning ?? '')}</p>
            </div>
          )}

          {/* Dynamic vs Applied Settings comparison */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2">Angewendete Einstellungen (dynamisch von Gemini)</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1.5 px-2 text-xs font-semibold text-gray-500">Parameter</th>
                    <th className="text-right py-1.5 px-2 text-xs font-semibold text-indigo-500">Gemini empfiehlt</th>
                    <th className="text-right py-1.5 px-2 text-xs font-semibold text-emerald-500">Angewendet</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(settingLabels).map(key => {
                    const geminiVal = dynamic ? dynamic[key] : undefined
                    const appliedVal = applied ? applied[key] : undefined
                    if (geminiVal === undefined && appliedVal === undefined) return null
                    const isDiff = geminiVal !== undefined && appliedVal !== undefined && String(geminiVal) !== String(appliedVal)
                    return (
                      <tr key={key} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-1.5 px-2 text-gray-700 font-medium">{settingLabels[key] ?? key}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-indigo-700">{geminiVal !== undefined ? String(geminiVal) : '–'}</td>
                        <td className={`py-1.5 px-2 text-right font-mono ${isDiff ? 'text-amber-600 font-bold' : 'text-emerald-700'}`}>
                          {appliedVal !== undefined ? String(appliedVal) : '–'}
                          {isDiff && <span className="ml-1 text-xs text-amber-500" title="Admin-Override aktiv">*</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-400 mt-2">* = Admin-Override aktiv (weicht von Gemini-Empfehlung ab)</p>
          </div>

          {/* Attributes detail */}
          {attrs && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Erkannte Attribute</h4>
              <div className="flex flex-wrap gap-2">
                {Object.entries(attrs).map(([key, val]) => (
                  <span key={key} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${
                    val === true ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    val === false ? 'bg-gray-50 text-gray-400 border-gray-200' :
                    'bg-blue-50 text-blue-700 border-blue-200'
                  }`}>
                    {key}: {String(val)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LastMosaicQualityPanel() {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('mosaicprint_last_debug_report')
      if (raw) setData(JSON.parse(raw))
    } catch { /* ignore */ }
    const handler = () => {
      try {
        const raw = localStorage.getItem('mosaicprint_last_debug_report')
        if (raw) setData(JSON.parse(raw))
      } catch { /* ignore */ }
    }
    window.addEventListener('mosaicDebugReportUpdated', handler)
    return () => window.removeEventListener('mosaicDebugReportUpdated', handler)
  }, [])

  if (!data) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2"><span>📊</span> Letztes Mosaik – Qualitätsanalyse</h3>
        <p className="text-sm text-gray-400 mt-2">Noch kein Mosaik generiert in dieser Browser-Sitzung. Erstelle ein Mosaik im Studio, dann erscheint hier die Analyse.</p>
      </div>
    )
  }

  const pool = data.pool as Record<string, unknown> | undefined
  const grid = data.grid as Record<string, unknown> | undefined
  const weights = data.weights as Record<string, number> | undefined
  const colorTransfer = data.colorTransfer as Record<string, unknown> | undefined
  const overlay = data.overlay as Record<string, unknown> | undefined
  const quality = data.quality as Record<string, unknown> | undefined
  const suggestions = data.suggestions as string[] | undefined
  const renderTime = data.renderTimeMs as number | undefined

  const deltaE = quality?.avgDeltaE as number | undefined
  const uniqueTiles = quality?.uniqueTiles as number | undefined
  const totalTiles = quality?.totalTiles as number | undefined
  const diversityPct = uniqueTiles && totalTiles ? Math.round((uniqueTiles / totalTiles) * 100) : undefined
  const deltaEColor = !deltaE ? 'text-gray-400' : deltaE < 15 ? 'text-green-600' : deltaE < 25 ? 'text-orange-500' : 'text-red-600'
  const deltaELabel = !deltaE ? '?' : deltaE < 15 ? '✅ Gut' : deltaE < 25 ? '⚠️ Mittel' : '❌ Niedrig'

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-3">
          <span className="text-xl">📊</span>
          <div className="text-left">
            <h3 className="font-bold text-gray-900">Letztes Mosaik – Qualitätsanalyse</h3>
            <p className="text-xs text-gray-500">
              {renderTime ? `Renderzeit: ${(renderTime/1000).toFixed(1)}s` : ''}
              {pool ? ` · ${(pool.loaded as number)?.toLocaleString('de-CH')} Tiles geladen` : ''}
              {deltaE ? ` · ΔE ${deltaE.toFixed(1)}` : ''}
            </p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲ Einklappen' : '▼ Anzeigen'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-5 space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-50 rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500 mb-1">Ø Farb-Abstand</div>
              <div className={`text-2xl font-bold ${deltaEColor}`}>{deltaE?.toFixed(1) ?? '?'}</div>
              <div className="text-xs text-gray-400">DeltaE (LAB)</div>
              <div className={`text-xs font-semibold mt-1 ${deltaEColor}`}>{deltaELabel}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500 mb-1">Einzigartige Fotos</div>
              <div className="text-2xl font-bold text-gray-900">{uniqueTiles?.toLocaleString('de-CH') ?? '?'}</div>
              <div className="text-xs text-gray-400">von {totalTiles?.toLocaleString('de-CH') ?? '?'}</div>
              {diversityPct !== undefined && (
                <div className={`text-xs font-semibold mt-1 ${diversityPct > 50 ? 'text-green-600' : diversityPct > 30 ? 'text-orange-500' : 'text-red-600'}`}>{diversityPct}% Diversität</div>
              )}
            </div>
            <div className="bg-gray-50 rounded-xl p-4 text-center">
              <div className="text-xs text-gray-500 mb-1">Matching-Modus</div>
              <div className="text-lg font-bold text-indigo-600">{pool?.matchingMode as string ?? '?'}</div>
              <div className="text-xs text-gray-400">Top-K = {pool?.topK as number ?? '?'}</div>
            </div>
          </div>
          {pool && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">1. Tile-Pool</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'DB-Index (gesamt)', value: (pool.dbTotal as number)?.toLocaleString('de-CH'), sub: '15D Feature-Vektor' },
                  { label: 'Geladen', value: (pool.loaded as number)?.toLocaleString('de-CH'), sub: 'Bilder im Speicher' },
                  { label: 'Nach Filter', value: (pool.afterFilter as number)?.toLocaleString('de-CH'), sub: pool.filterNote as string },
                  { label: 'Matching-Modus', value: pool.matchingMode as string, sub: `Top-K = ${pool.topK ?? '?'}`, valueClass: 'text-green-600' },
                ].map(item => (
                  <div key={item.label} className="bg-white rounded-lg p-3">
                    <div className="text-xs text-gray-400">{item.label}</div>
                    <div className={`text-lg font-bold ${(item as {valueClass?: string}).valueClass ?? 'text-gray-900'}`}>{item.value ?? '?'}</div>
                    {item.sub && <div className="text-xs text-gray-400 mt-0.5">{item.sub}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {grid && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">2. Gitter & Matching</h4>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                {[
                  { label: 'Spalten', value: grid.cols },
                  { label: 'Zeilen', value: grid.rows },
                  { label: 'Kacheln', value: (grid.total as number)?.toLocaleString('de-CH') },
                  { label: 'Tile-Px', value: `${grid.tilePx}px` },
                  { label: 'Max-Reuse', value: grid.maxReuse },
                  { label: 'Rotation', value: grid.rotation ? 'Ja' : 'Nein' },
                ].map(item => (
                  <div key={item.label} className="bg-white rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-400">{item.label}</div>
                    <div className="text-base font-bold text-gray-900">{String(item.value ?? '?')}</div>
                  </div>
                ))}
              </div>
              {Boolean(grid.antiRepeat) && <div className="mt-2 text-xs text-gray-500">Anti-Repetitions-Radius: {String((grid.antiRepeat as Record<string,unknown>)?.radius ?? '')} Kacheln · Penalty {String((grid.antiRepeat as Record<string,unknown>)?.penalty ?? '')}</div>}
              {Boolean(grid.faceDetection) && <div className="mt-1 text-xs text-gray-500">Gesichtserkennung: {String((grid.faceDetection as Record<string,unknown>)?.count ?? '')} Gesicht · {String((grid.faceDetection as Record<string,unknown>)?.pct ?? '')}% Kacheln</div>}
            </div>
          )}
          {weights && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">3. Scoring-Gewichte</h4>
              <div className="space-y-2">
                {Object.entries(weights).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-3">
                    <div className="w-44 text-xs text-gray-600 shrink-0">{key}</div>
                    <div className="flex-1 bg-gray-200 rounded-full h-2"><div className="bg-indigo-500 h-2 rounded-full" style={{ width: `${Math.min(100, val * 100)}%` }} /></div>
                    <div className="w-10 text-right text-xs font-bold text-gray-700">{Math.round(val * 100)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {colorTransfer && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">4. Farb-Transfer (Reinhard-Stil)</h4>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                {Object.entries(colorTransfer).map(([key, val]) => (
                  <div key={key} className="bg-white rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-400">{key}</div>
                    <div className="text-base font-bold text-gray-900">{String(val)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {overlay && (
            <div className="bg-gray-50 rounded-xl p-4">
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">5. Overlay</h4>
              <div className="grid grid-cols-3 gap-3">
                {Object.entries(overlay).map(([key, val]) => (
                  <div key={key} className="bg-white rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-400">{key}</div>
                    <div className="text-base font-bold text-gray-900">{String(val)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {suggestions && suggestions.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <h4 className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-2">💡 Wie verbessere ich das Ergebnis?</h4>
              <ul className="space-y-1">{suggestions.map((s, i) => <li key={i} className="text-xs text-amber-700 flex items-start gap-1.5"><span className="mt-0.5 shrink-0">•</span> {s}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Quality Assurance Tab ─────────────────────────────────────────────────────
// (QaRun, QaItem interfaces and QA_CHECKS const are declared above Admin component to avoid TDZ)
function QualityAssurance({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const { authHeaders } = useAuth();
  const [runs, setRuns] = useState<QaRun[]>([])
  const [runningChecks, setRunningChecks] = useState<Set<string>>(new Set())
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [runItems, setRunItems] = useState<QaItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(Date.now())

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getQualityRuns?input=' + encodeURIComponent(JSON.stringify({ limit: 50 })), { headers: authHeaders() })
      const data = await res.json()
      const rows: QaRun[] = data.result?.data?.json ?? data.result?.data ?? []
      setRuns(rows)
      // Auto-refresh while any check is running
      const anyRunning = rows.some((r: QaRun) => r.status === 'running')
      if (anyRunning) setTimeout(() => setLastRefresh(Date.now()), 1500)
      // Detect newly completed checks and notify
      setRuns(prev => {
        for (const newRun of rows) {
          const old = prev.find(p => p.id === newRun.id)
          if (old?.status === 'running' && (newRun.status === 'success' || newRun.status === 'warning' || newRun.status === 'error')) {
            const dur = newRun.finishedAt ? Math.round((new Date(newRun.finishedAt).getTime() - new Date(newRun.startedAt).getTime()) / 1000) : 0
            const emoji = newRun.status === 'success' ? '✅' : newRun.status === 'warning' ? '⚠️' : '❌'
            onMessage({ text: `${emoji} ${newRun.checkType} abgeschlossen (${dur}s)`, type: newRun.status === 'error' ? 'error' : 'success' })
          }
        }
        return rows
      })
    } catch { /* ignore */ }
  }, [authHeaders])

  useEffect(() => { fetchRuns() }, [fetchRuns, lastRefresh])

  const fetchItems = useCallback(async (runId: number) => {
    setLoadingItems(true)
    try {
      const res = await fetch('/api/trpc/getQualityRunItems?input=' + encodeURIComponent(JSON.stringify({ runId })), { headers: authHeaders() })
      const data = await res.json()
      setRunItems(data.result?.data?.json ?? data.result?.data ?? [])
    } catch { /* ignore */ }
    finally { setLoadingItems(false) }
  }, [authHeaders])

  useEffect(() => {
    if (selectedRun !== null) fetchItems(selectedRun)
  }, [selectedRun, fetchItems])

  const runCheck = useCallback(async (checkType: string) => {
    setRunningChecks(prev => new Set([...prev, checkType]))
    try {
      const res = await fetch('/api/trpc/runQualityCheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ checkType }),
      })
      const data = await res.json()
      if (data.result?.data?.json?.started || data.result?.data?.started) {
        onMessage({ text: `${checkType} gestartet`, type: 'info' })
        setTimeout(() => { setLastRefresh(Date.now()); setRunningChecks(prev => { const n = new Set(prev); n.delete(checkType); return n }) }, 1500)
      }
    } catch (e) {
      onMessage({ text: `Fehler: ${String(e)}`, type: 'error' })
      setRunningChecks(prev => { const n = new Set(prev); n.delete(checkType); return n })
    }
  }, [onMessage])

  const runAll = useCallback(() => runCheck('all'), [runCheck])

  const statusColor = (s: string) => {
    if (s === 'success') return 'text-green-600 bg-green-50'
    if (s === 'warning') return 'text-amber-600 bg-amber-50'
    if (s === 'error') return 'text-red-600 bg-red-50'
    if (s === 'running') return 'text-blue-600 bg-blue-50'
    return 'text-gray-500 bg-gray-50'
  }
  const itemStatusColor = (s: string) => {
    if (s === 'pass') return 'text-green-700 bg-green-50 border-green-200'
    if (s === 'warn') return 'text-amber-700 bg-amber-50 border-amber-200'
    if (s === 'fail') return 'text-red-700 bg-red-50 border-red-200'
    return 'text-gray-600 bg-gray-50 border-gray-200'
  }
  const statusEmoji = (s: string) => ({ success: '✅', warning: '⚠️', error: '❌', running: '⏳' }[s] ?? '❓')

  // Group runs by checkType for "last run" display
  const lastRunByType: Record<string, QaRun> = {}
  for (const run of runs) {
    if (!lastRunByType[run.checkType] || run.id > lastRunByType[run.checkType].id) {
      lastRunByType[run.checkType] = run
    }
  }

  const [pdfGenerating, setPdfGenerating] = useState(false)
  // ── Auto-Learn state ──────────────────────────────────────────────────────
  const [autoLearnRunning, setAutoLearnRunning] = useState(false)
  const [autoLearnImportCount, setAutoLearnImportCount] = useState(300)
  const [autoLearnTargetPerBucket, setAutoLearnTargetPerBucket] = useState(200)
  const [autoLearnSteps, setAutoLearnSteps] = useState<Array<{step: string; status: string; message: string; ts: string}>>([])
  const [autoLearnRuns, setAutoLearnRuns] = useState<Array<{id: number; status: string; started_at: string; finished_at: string | null; steps_json: unknown}>>([])
  const [autoLearnExpandedRun, setAutoLearnExpandedRun] = useState<number | null>(null)
  const [autoLearnRunsExpanded, setAutoLearnRunsExpanded] = useState(false)
  const fetchAutoLearnRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getAutoLearnRuns', { headers: authHeaders() })
      const data = await res.json()
      const rows = data.result?.data?.json ?? data.result?.data ?? []
      if (Array.isArray(rows)) setAutoLearnRuns(rows)
    } catch { /* ignore */ }
  }, [authHeaders])
  useEffect(() => { fetchAutoLearnRuns() }, [fetchAutoLearnRuns])
  const startAutoLearn = useCallback(async () => {
    setAutoLearnRunning(true)
    setAutoLearnSteps([])
    try {
      const res = await fetch('/api/trpc/startAutoLearnCycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ importCount: autoLearnImportCount, targetPerBucket: autoLearnTargetPerBucket }),
      })
      const data = await res.json()
      const runId: number = data.result?.data?.json?.runId ?? data.result?.data?.runId
      if (!runId) throw new Error('Kein runId erhalten')
      onMessage({ text: `Auto-Learn-Zyklus gestartet (Run #${runId})`, type: 'info' })
      // Poll status
      const poll = setInterval(async () => {
        try {
          const r2 = await fetch('/api/trpc/getAutoLearnRun?input=' + encodeURIComponent(JSON.stringify({ runId })), { headers: authHeaders() })
          const d2 = await r2.json()
          const run = d2.result?.data?.json ?? d2.result?.data
          if (!run) return
          const steps = Array.isArray(run.steps_json) ? run.steps_json : []
          setAutoLearnSteps(steps)
          if (run.status !== 'running') {
            clearInterval(poll)
            setAutoLearnRunning(false)
            fetchAutoLearnRuns()
            const emoji = run.status === 'success' ? '✅' : run.status === 'error' ? '❌' : '⚠️'
            onMessage({ text: `${emoji} Auto-Learn-Zyklus beendet (${run.status})`, type: run.status === 'error' ? 'error' : 'success' })
          }
        } catch { /* ignore */ }
      }, 3000)
    } catch (e) {
      onMessage({ text: `Fehler beim Starten: ${String(e)}`, type: 'error' })
      setAutoLearnRunning(false)
    }
  }, [autoLearnImportCount, autoLearnTargetPerBucket, onMessage, fetchAutoLearnRuns])
  const [testImageUrl, setTestImageUrl] = useState('')
  const [testImageFile, setTestImageFile] = useState<{ name: string; base64: string; preview: string } | null>(null)
  const [testAnalysis, setTestAnalysis] = useState<Record<string, unknown> | null>(null)
  const [testAnalyzing, setTestAnalyzing] = useState(false)
  const [detectedCategory, setDetectedCategory] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [categories, setCategories] = useState<Array<{name: string; label: string; parent_category: string; keywords: string[]; algo_settings: Record<string, unknown>; description: string}>>([])  
  const [showCategoryProfiles, setShowCategoryProfiles] = useState(false)
  const [selectedCategoryProfile, setSelectedCategoryProfile] = useState<string | null>(null)
  // Auto-Optimize Loop
  const [autoOptimizeRunning, setAutoOptimizeRunning] = useState(false)
  const [autoOptimizeLog, setAutoOptimizeLog] = useState<Array<{iter: number; deltaE: number; params: Record<string, number>; improved: boolean}>>([]) 
  const [autoOptimizeDeltaTarget, setAutoOptimizeDeltaTarget] = useState(15)
  const [autoOptimizeBestScore, setAutoOptimizeBestScore] = useState<number | null>(null)
  const [autoOptimizeBestParams, setAutoOptimizeBestParams] = useState<Record<string, number> | null>(null)
  const [autoOptimizeExpanded, setAutoOptimizeExpanded] = useState(false)
  // Analysis-Import
  const [analysisImportRunning, setAnalysisImportRunning] = useState(false)
  const [analysisImportJob, setAnalysisImportJob] = useState<SmartImportJob | null>(null)
  const [analysisImportSource, setAnalysisImportSource] = useState<'pexels' | 'unsplash' | 'pixabay'>('pexels')

  // Load categories from DB
  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getImageCategories', { headers: authHeaders() })
      const data = await res.json()
      const result = data.result?.data?.json ?? data.result?.data ?? data
      if (Array.isArray(result)) setCategories(result)
    } catch { /* ignore */ }
  }, [authHeaders])
  useEffect(() => { fetchCategories() }, [fetchCategories])

  // Detect category from LAB zones
  const detectCategory = (labZones: Array<{L: number; a: number; b: number; count: number}>): string | null => {
    if (!labZones || labZones.length === 0) return null
    const avgL = labZones.reduce((s, z) => s + z.L * z.count, 0) / labZones.reduce((s, z) => s + z.count, 0)
    const avgA = labZones.reduce((s, z) => s + z.a * z.count, 0) / labZones.reduce((s, z) => s + z.count, 0)
    const avgB = labZones.reduce((s, z) => s + z.b * z.count, 0) / labZones.reduce((s, z) => s + z.count, 0)
    // Skin tone detection: warm, medium L, low chroma
    const chroma = Math.sqrt(avgA * avgA + avgB * avgB)
    const isSkinTone = chroma < 30 && avgL > 35 && avgL < 85 && avgA > 0 && avgB > 0
    if (isSkinTone) {
      if (avgL > 70) return 'portrait_light_skin'
      if (avgL > 55) return 'portrait_medium_skin'
      return 'portrait_dark_skin'
    }
    // Blue/cool = ocean or sky
    if (avgA < -5 && avgB < -5 && avgL > 40) return 'nature_ocean'
    // Green = forest
    if (avgA < -8 && avgB > 0) return 'nature_forest'
    // Warm orange/red = sunset
    if (avgA > 10 && avgB > 15 && avgL > 40 && avgL < 75) return 'nature_sunset'
    // Very bright + cool = snow
    if (avgL > 75 && chroma < 15) return 'nature_snow'
    // Dark + low chroma = city night
    if (avgL < 35 && chroma < 20) return 'city_night'
    return null
  }

  const saveProfileForCategory = async (categoryName: string) => {
    setSavingProfile(true)
    try {
      const currentSettings = loadSettings()
      const res = await fetch('/api/trpc/saveImageCategoryAlgoSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ categoryName, algoSettings: currentSettings }),
      })
      const data = await res.json()
      if (data.result?.data?.json?.ok || data.result?.data?.ok) {
        onMessage({ text: `✅ Algorithmus-Profil für "${categories.find(c => c.name === categoryName)?.label ?? categoryName}" gespeichert`, type: 'success' })
        fetchCategories()
      }
    } catch (e) {
      onMessage({ text: `Fehler beim Speichern: ${String(e)}`, type: 'error' })
    } finally { setSavingProfile(false) }
  }

  // ── Analysis-Import: Import images based on keywords from image analysis ──────
  const startAnalysisImport = useCallback(async () => {
    if (!testAnalysis) return
    const keywords = (testAnalysis.keywordSuggestions as Array<{keyword: string; reason: string; priority: string}> ?? [])
      .map(s => s.keyword)
      .filter(Boolean)
    if (keywords.length === 0) { onMessage({ text: 'Keine Keywords aus der Analyse vorhanden', type: 'error' }); return }
    setAnalysisImportRunning(true)
    setAnalysisImportJob({ running: true, log: [`🚀 Starte Analyse-Import: ${keywords.length} Keywords via ${analysisImportSource}...`], imported: 0, total: keywords.length * 30 })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          sourceId: analysisImportSource,
          count: keywords.length * 30,
          keywords,
          jobLabel: (testAnalysis.falSceneType as string) ?? 'Bildanalyse',
        }),
      })
      // Poll status
      const poll = async () => {
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: analysisImportSource, isAnalysis: true }))
          const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`, { headers: authHeaders() })
          const data = await res.json()
          const job = data.result?.data?.json ?? data.result?.data ?? data
          setAnalysisImportJob({ running: job.running, log: job.log ?? [], imported: job.imported ?? 0, total: job.total ?? 0, error: job.error, finishedAt: job.finishedAt })
          if (job.running) setTimeout(poll, 2000)
          else setAnalysisImportRunning(false)
        } catch { setAnalysisImportRunning(false) }
      }
      setTimeout(poll, 1500)
    } catch (e) {
      setAnalysisImportRunning(false)
      onMessage({ text: `Import-Fehler: ${String(e)}`, type: 'error' })
    }
  }, [testAnalysis, analysisImportSource, onMessage])

  // ── Auto-Optimize Loop: iterative parameter tuning with DeltaE feedback ──────
  // Uses the Studio canvas rendering pipeline via an iframe message bridge
  const runAutoOptimize = useCallback(async () => {
    if (!testImageFile && !testImageUrl) { onMessage({ text: 'Bitte zuerst ein Bild hochladen und analysieren', type: 'error' }); return }
    if (!testAnalysis) { onMessage({ text: 'Bitte zuerst das Bild analysieren', type: 'error' }); return }
    setAutoOptimizeRunning(true)
    setAutoOptimizeLog([])
    setAutoOptimizeBestScore(null)
    setAutoOptimizeBestParams(null)
    setAutoOptimizeExpanded(true)

    // Load current settings as starting point
    const baseSettings = loadSettings()
    const tunable = [
      { key: 'labWeight', min: 0.10, max: 0.55, step: 0.05 },
      { key: 'brightnessWeight', min: 0.20, max: 0.65, step: 0.05 },
      { key: 'textureWeight', min: 0.05, max: 0.35, step: 0.05 },
      { key: 'contrastBoost', min: 1.00, max: 1.80, step: 0.10 },
      { key: 'histogramBlend', min: 0.00, max: 0.20, step: 0.02 },
      { key: 'baseOverlay', min: 0.00, max: 0.30, step: 0.05 },
    ]

    // Helper: compute DeltaE from two canvas data arrays (CIEDE2000 simplified)
    const computeDeltaE = (orig: ImageData, mosaic: ImageData): number => {
      let total = 0; let count = 0
      const step = 8 // sample every 8th pixel for speed
      for (let i = 0; i < orig.data.length; i += 4 * step) {
        const r1 = orig.data[i], g1 = orig.data[i+1], b1 = orig.data[i+2]
        const r2 = mosaic.data[i], g2 = mosaic.data[i+1], b2 = mosaic.data[i+2]
        // sRGB → LAB (simplified)
        const toL = (r: number, g: number, b: number) => {
          const rn = r/255, gn = g/255, bn = b/255
          const x = 0.4124*rn + 0.3576*gn + 0.1805*bn
          const y = 0.2126*rn + 0.7152*gn + 0.0722*bn
          const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116
          return 116 * f(y/1.0) - 16
        }
        const l1 = toL(r1,g1,b1), l2 = toL(r2,g2,b2)
        const da = (r1-r2)*0.5, db = (g1-g2)*0.5
        total += Math.sqrt((l1-l2)**2 + da**2 + db**2)
        count++
      }
      return count > 0 ? total / count : 99
    }

    // Helper: render mosaic in offscreen canvas using Studio's localStorage settings
    const renderMosaicOffscreen = async (settings: Record<string, unknown>): Promise<number> => {
      // Save settings to localStorage (Studio reads from there)
      localStorage.setItem('mosaicSettings', JSON.stringify({ ...baseSettings, ...settings }))
      window.dispatchEvent(new Event('mosaicSettingsChanged'))
      // Wait for Studio to re-render (it listens to mosaicSettingsChanged)
      await new Promise(r => setTimeout(r, 800))
      // Read the last debug report from localStorage (Studio writes it after each render)
      const reportRaw = localStorage.getItem('mosaicprint_last_debug_report')
      if (!reportRaw) return 99
      const report = JSON.parse(reportRaw)
      // Use avgDeltaE from report if available
      if (typeof report.avgDeltaE === 'number' && report.avgDeltaE > 0) return report.avgDeltaE
      // Fallback: use diversity score as proxy
      const diversity = report.uniqueTiles ? report.uniqueTiles / Math.max(1, report.totalCells) : 0
      return 30 - diversity * 15 // rough proxy: higher diversity → lower deltaE
    }

    const MAX_ITER = 10
    let bestScore = 99
    let bestParams: Record<string, number> = {}
    let currentParams: Record<string, number> = {}
    tunable.forEach(t => { currentParams[t.key] = (baseSettings as unknown as Record<string, number>)[t.key] ?? (t.min + t.max) / 2 })

    try {
      for (let iter = 0; iter < MAX_ITER; iter++) {
        // Try random perturbation of one parameter
        const paramToTune = tunable[iter % tunable.length]
        const candidate = { ...currentParams }
        // Hill-climbing: try +step and -step
        const directions = [paramToTune.step, -paramToTune.step]
        let improved = false
        for (const delta of directions) {
          const newVal = Math.max(paramToTune.min, Math.min(paramToTune.max, candidate[paramToTune.key] + delta))
          const testParams = { ...candidate, [paramToTune.key]: newVal }
          const score = await renderMosaicOffscreen(testParams)
          if (score < bestScore) {
            bestScore = score
            bestParams = { ...testParams }
            currentParams = { ...testParams }
            improved = true
          }
        }
        const logEntry = { iter: iter + 1, deltaE: Math.round(bestScore * 10) / 10, params: { ...currentParams }, improved }
        setAutoOptimizeLog(prev => [...prev, logEntry])
        setAutoOptimizeBestScore(Math.round(bestScore * 10) / 10)
        if (improved) setAutoOptimizeBestParams({ ...bestParams })
        if (bestScore <= autoOptimizeDeltaTarget) {
          onMessage({ text: `✅ Ziel erreicht! DeltaE ${Math.round(bestScore*10)/10} ≤ ${autoOptimizeDeltaTarget} nach ${iter+1} Iterationen`, type: 'success' })
          break
        }
      }
      // Apply best params
      if (Object.keys(bestParams).length > 0) {
        const finalSettings = { ...baseSettings, ...bestParams }
        localStorage.setItem('mosaicSettings', JSON.stringify(finalSettings))
        window.dispatchEvent(new Event('mosaicSettingsChanged'))
        onMessage({ text: `🎯 Auto-Optimize abgeschlossen. Beste DeltaE: ${Math.round(bestScore*10)/10}. Einstellungen übernommen.`, type: 'success' })
      }
    } catch (e) {
      onMessage({ text: `Auto-Optimize Fehler: ${String(e)}`, type: 'error' })
    } finally { setAutoOptimizeRunning(false) }
  }, [testAnalysis, testImageFile, testImageUrl, autoOptimizeDeltaTarget, onMessage])

  const downloadPdfReport = useCallback(async () => {
    setPdfGenerating(true)
    try {
      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const now = new Date().toLocaleString('de-CH')
      const pageW = 210; const margin = 14; const colW = pageW - 2 * margin

      // Title
      doc.setFontSize(20); doc.setFont('helvetica', 'bold')
      doc.setTextColor(30, 30, 30)
      doc.text('MosaicPrint QA-Report', margin, 22)
      doc.setFontSize(10); doc.setFont('helvetica', 'normal')
      doc.setTextColor(100, 100, 100)
      doc.text(`Erstellt: ${now}`, margin, 30)
      doc.setDrawColor(200, 200, 200); doc.line(margin, 34, pageW - margin, 34)

      let y = 42
      const addSection = (title: string) => {
        if (y > 260) { doc.addPage(); y = 20 }
        doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.setTextColor(50, 50, 200)
        doc.text(title, margin, y); y += 7
        doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50)
      }
      const addRow = (label: string, value: string, indent = 0) => {
        if (y > 270) { doc.addPage(); y = 20 }
        doc.setFontSize(9)
        doc.setFont('helvetica', 'bold'); doc.text(label, margin + indent, y)
        doc.setFont('helvetica', 'normal'); doc.text(value, margin + indent + 55, y)
        y += 5.5
      }
      const addText = (text: string) => {
        if (y > 270) { doc.addPage(); y = 20 }
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80)
        const lines = doc.splitTextToSize(text, colW)
        doc.text(lines, margin, y); y += lines.length * 5 + 2
        doc.setTextColor(50, 50, 50)
      }

      // ── Section 1: Letztes Mosaik – Qualitäts-Score ──────────────────────────
      addSection('1. Letztes Mosaik – Qualitäts-Score')
      let lastReport: Record<string, unknown> | null = null
      try { lastReport = JSON.parse(localStorage.getItem('mosaicprint_last_debug_report') || 'null') } catch {}
      if (!lastReport) {
        addText('Noch kein Mosaik generiert. Erstelle ein Mosaik im Studio, dann erscheint hier die Analyse.')
      } else {
        const q = lastReport.quality as Record<string, unknown> | undefined
        const p = lastReport.pool as Record<string, unknown> | undefined
        const g = lastReport.grid as Record<string, unknown> | undefined
        const w = lastReport.weights as Record<string, number> | undefined
        const ct = lastReport.colorTransfer as Record<string, unknown> | undefined
        const ov = lastReport.overlay as Record<string, unknown> | undefined
        const renderMs = lastReport.renderTimeMs as number | undefined

        if (q) {
          const dE = q.avgDeltaE as number | undefined
          const uTiles = q.uniqueTiles as number | undefined
          const tTiles = q.totalTiles as number | undefined
          const dELabel = !dE ? 'n/a' : dE < 15 ? 'GUT' : dE < 25 ? 'MITTEL' : 'NIEDRIG'
          addRow('Ø Farb-Abstand (DeltaE)', dE ? `${dE.toFixed(1)} (${dELabel})` : 'n/a')
          addRow('Einzigartige Fotos', uTiles ? `${uTiles.toLocaleString('de-CH')} von ${tTiles?.toLocaleString('de-CH') ?? '?'} Kacheln (${uTiles && tTiles ? Math.round(uTiles/tTiles*100) : '?'}% Diversität)` : 'n/a')
          if (q.satLow !== undefined) addRow('Sättigungs-Verteilung', `Grau/Neutral: ${q.satLow}%  |  Mittel: ${q.satMid}%  |  Sättigt: ${q.satHigh}%`)
          if (renderMs) addRow('Renderzeit', `${(renderMs / 1000).toFixed(1)}s`)
        }
        y += 3
        if (p) {
          addRow('Tile-Pool (DB)', `${(p.dbTotal as number)?.toLocaleString('de-CH') ?? '?'} Tiles im 15D-Index`)
          addRow('Geladen / Nach Filter', `${(p.loaded as number)?.toLocaleString('de-CH') ?? '?'} / ${(p.afterFilter as number)?.toLocaleString('de-CH') ?? '?'}`)
          addRow('Matching-Modus', `${p.matchingMode ?? '?'} | Top-K = ${p.topK ?? '?'}`)
        }
        if (g) {
          y += 3
          addRow('Gitter', `${g.cols} x ${g.rows} = ${(g.total as number)?.toLocaleString('de-CH')} Kacheln | ${g.tilePx}px pro Tile`)
          addRow('Anti-Repetition', `Radius ${(g.antiRepeat as Record<string,unknown>)?.radius ?? '?'} | Penalty ${(g.antiRepeat as Record<string,unknown>)?.penalty ?? '?'}`)
          addRow('Gesichtserkennung', `${(g.faceDetection as Record<string,unknown>)?.count ?? 0} Gesichter | ${(g.faceDetection as Record<string,unknown>)?.pct ?? 0}% Kacheln`)
        }
        if (w) {
          y += 3
          doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(50, 50, 50)
          doc.text('Scoring-Gewichte:', margin, y); y += 5
          doc.setFont('helvetica', 'normal')
          for (const [key, val] of Object.entries(w)) {
            const barW = Math.round(val * 80)
            doc.setFillColor(99, 102, 241)
            doc.rect(margin + 55, y - 3.5, barW, 3.5, 'F')
            doc.setFontSize(8)
            doc.text(key, margin, y)
            doc.text(`${Math.round(val * 100)}%`, margin + 55 + barW + 2, y)
            y += 5
          }
        }
        if (ct) {
          y += 3
          addRow('Farb-Transfer', Object.entries(ct).map(([k, v]) => `${k}: ${v}`).join('  |  '))
        }
        if (ov) {
          addRow('Overlay', Object.entries(ov).map(([k, v]) => `${k}: ${v}`).join('  |  '))
        }
        // Suggestions
        const suggestions = lastReport.suggestions as string[] | undefined
        if (suggestions && suggestions.length > 0) {
          y += 4
          doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(180, 100, 0)
          doc.text('Verbesserungshinweise:', margin, y); y += 6
          doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 60, 0)
          for (const s of suggestions) {
            if (y > 270) { doc.addPage(); y = 20 }
            const lines = doc.splitTextToSize(`• ${s}`, colW - 4)
            doc.setFontSize(9); doc.text(lines, margin + 2, y); y += lines.length * 5 + 2
          }
          doc.setTextColor(50, 50, 50)
        }
      }

      // ── Section 2: Check-Übersicht ─────────────────────────────────────────────
      y += 6
      addSection('2. QA-Check-Übersicht')
      if (runs.length === 0) {
        addText('Noch keine Checks ausgeführt.')
      } else {
        for (const [checkType, run] of Object.entries(lastRunByType)) {
          const dur = run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : 'laufend'
          addRow(checkType, `${run.status.toUpperCase()} | ${new Date(run.startedAt).toLocaleString('de-CH')} | Dauer: ${dur}`)
          if (run.summary) {
            for (const [k, v] of Object.entries(run.summary).slice(0, 6)) {
              addRow('', `${k}: ${String(v)}`, 8)
            }
          }
          y += 2
        }
      }

      // ── Section 3: Run-Verlauf ────────────────────────────────────────────────
      y += 4
      addSection('3. Run-Verlauf (letzte 20)')
      const recent = runs.slice(0, 20)
      for (const run of recent) {
        const dur = run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '—'
        addRow(`#${run.id} ${run.checkType}`, `${run.status} | ${new Date(run.startedAt).toLocaleString('de-CH')} | ${dur}`)
      }

      // ── Section 4: Empfehlungen ───────────────────────────────────────────────
      y += 4
      addSection('4. Empfehlungen')
      const failedChecks = Object.entries(lastRunByType).filter(([, r]) => r.status === 'error' || r.status === 'warning')
      if (failedChecks.length === 0) {
        addText('Alle Checks bestanden. Keine Massnahmen erforderlich.')
      } else {
        for (const [checkType, run] of failedChecks) {
          addText(`${checkType}: ${run.status.toUpperCase()} - Details im Check-Tab pruefen.`)
        }
      }

      // Footer
      const pageCount = doc.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i)
        doc.setFontSize(8); doc.setTextColor(150, 150, 150)
        doc.text(`MosaicPrint QA-Report | Seite ${i} / ${pageCount} | ${now}`, margin, 290)
      }

      doc.save(`mosaicprint-qa-report-${new Date().toISOString().slice(0, 10)}.pdf`)
      onMessage({ text: 'PDF-Report heruntergeladen', type: 'success' })
    } catch (e) {
      onMessage({ text: `PDF-Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setPdfGenerating(false)
    }
  }, [runs, lastRunByType, onMessage])

  const handleTestFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    if (file.type === 'application/pdf') {
      // For PDF: render first page via PDF.js in a canvas and extract as JPEG
      reader.onload = async (ev) => {
        try {
          const typedArray = new Uint8Array(ev.target!.result as ArrayBuffer)
          // Dynamically import PDF.js
          const pdfjsLib = await import('pdfjs-dist')
          pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
          const pdf = await pdfjsLib.getDocument({ data: typedArray }).promise
          const page = await pdf.getPage(1)
          const viewport = page.getViewport({ scale: 1.5 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width; canvas.height = viewport.height
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas } as Parameters<typeof page.render>[0]).promise
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
          setTestImageFile({ name: file.name, base64: dataUrl, preview: dataUrl })
          setTestImageUrl('')
        } catch (err) {
          onMessage({ text: `PDF-Fehler: ${String(err)}`, type: 'error' })
        }
      }
      reader.readAsArrayBuffer(file)
    } else {
      // JPG/PNG: read as data URL directly
      reader.onload = (ev) => {
        const dataUrl = ev.target!.result as string
        setTestImageFile({ name: file.name, base64: dataUrl, preview: dataUrl })
        setTestImageUrl('')
      }
      reader.readAsDataURL(file)
    }
    // Reset input so same file can be re-selected
    e.target.value = ''
  }, [onMessage])

  // Client-side LAB computation + Feature Vector via Canvas (no server-side image processing needed)
  const computeLabZonesFromImage = useCallback((src: string): Promise<{
    labZones: Array<{L: number; a: number; b: number; count: number}>;
    featureVector: {
      sceneType: string;        // portrait | landscape | cityscape | abstract | unknown
      textureLevel: string;     // low | medium | high
      edgeDensity: number;      // 0-1
      brightnessRange: string;  // narrow | medium | wide
      avgL: number;             // 0-100
      avgChroma: number;        // 0-100
      dominantColors: string[]; // e.g. ['warm', 'blue', 'green']
      facesDetected: boolean;   // heuristic: skin tones present
      skyDetected: boolean;     // heuristic: bright blue/grey top region
      waterDetected: boolean;   // heuristic: blue/teal mid region
      tileType: string;         // calm | medium | busy
    };
  }> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        const SIZE = 64
        const canvas = document.createElement('canvas')
        canvas.width = SIZE; canvas.height = SIZE
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, SIZE, SIZE)
        const { data } = ctx.getImageData(0, 0, SIZE, SIZE)

        // rgbToLab aus colorUtils (keine lokale Duplikation mehr)
        const rgbToLab = (r: number, g: number, b: number) => {
          const [L, a, b_] = rgbToLabUtil(r, g, b)
          return { L, a, b: b_ }
        }

        // ── 1. LAB zones (for pool comparison) ──
        const zones: Record<string, {L: number; a: number; b: number; count: number}> = {}
        const allLab: Array<{L: number; a: number; b: number}> = []
        for (let i = 0; i < data.length; i += 4) {
          const lab = rgbToLab(data[i], data[i+1], data[i+2])
          allLab.push(lab)
          const L = Math.round(lab.L / 8) * 8
          const a = Math.round(lab.a / 8) * 8
          const bv = Math.round(lab.b / 8) * 8
          const key = `${L},${a},${bv}`
          if (!zones[key]) zones[key] = { L, a, b: bv, count: 0 }
          zones[key].count++
        }
        const labZones = Object.values(zones).sort((a, b) => b.count - a.count).slice(0, 30)

        // ── 2. Global averages ──
        const totalPx = allLab.length
        const avgL = allLab.reduce((s, p) => s + p.L, 0) / totalPx
        const avgA = allLab.reduce((s, p) => s + p.a, 0) / totalPx
        const avgB = allLab.reduce((s, p) => s + p.b, 0) / totalPx
        const avgChroma = allLab.reduce((s, p) => s + Math.sqrt(p.a*p.a + p.b*p.b), 0) / totalPx

        // ── 3. Brightness range (std dev of L) ──
        const lStdDev = Math.sqrt(allLab.reduce((s, p) => s + Math.pow(p.L - avgL, 2), 0) / totalPx)
        const brightnessRange = lStdDev < 15 ? 'narrow' : lStdDev < 30 ? 'medium' : 'wide'

        // ── 4. Edge density (Sobel on grayscale) ──
        const gray = new Float32Array(SIZE * SIZE)
        for (let i = 0; i < totalPx; i++) gray[i] = allLab[i].L / 100
        let edgeSum = 0
        for (let y = 1; y < SIZE - 1; y++) {
          for (let x = 1; x < SIZE - 1; x++) {
            const idx = (r: number, c: number) => gray[r * SIZE + c]
            const gx = -idx(y-1,x-1) + idx(y-1,x+1) - 2*idx(y,x-1) + 2*idx(y,x+1) - idx(y+1,x-1) + idx(y+1,x+1)
            const gy = -idx(y-1,x-1) - 2*idx(y-1,x) - idx(y-1,x+1) + idx(y+1,x-1) + 2*idx(y+1,x) + idx(y+1,x+1)
            edgeSum += Math.sqrt(gx*gx + gy*gy)
          }
        }
        const edgeDensity = Math.min(1, edgeSum / ((SIZE-2)*(SIZE-2) * 2))
        const textureLevel = edgeDensity < 0.15 ? 'low' : edgeDensity < 0.35 ? 'medium' : 'high'

        // ── 5. Tile type (calm/medium/busy) ──
        const chromaVariance = allLab.reduce((s, p) => s + Math.pow(Math.sqrt(p.a*p.a+p.b*p.b) - avgChroma, 2), 0) / totalPx
        const tileType = edgeDensity < 0.12 && chromaVariance < 100 ? 'calm'
          : edgeDensity > 0.30 || chromaVariance > 400 ? 'busy' : 'medium'

        // ── 6. Dominant color hues ──
        const dominantColors: string[] = []
        if (avgL > 70 && avgChroma < 15) dominantColors.push('white/neutral')
        else if (avgL < 30 && avgChroma < 15) dominantColors.push('dark/black')
        if (avgA > 8 && avgB > 8) dominantColors.push('warm/orange')
        if (avgA > 12 && avgB < 5) dominantColors.push('red')
        if (avgA < -8 && avgB > 8) dominantColors.push('green')
        if (avgA < -5 && avgB < -5) dominantColors.push('blue/cool')
        if (avgB > 15 && avgA > 0) dominantColors.push('yellow/golden')
        if (avgChroma > 40) dominantColors.push('saturated')
        if (dominantColors.length === 0) dominantColors.push('neutral')

        // ── 7. Heuristic scene detection ──
        // Skin tones: warm, medium L, low-medium chroma
        // Stricter filter: require both reddish (a>5) AND warm (b>8) to avoid warm rocks/sand
        const skinPixels = allLab.filter(p => p.a > 5 && p.b > 8 && p.L > 35 && p.L < 80 && Math.sqrt(p.a*p.a+p.b*p.b) < 40).length
        // Portrait requires significant skin area (>20%) AND no dominant sky/water context
        const skinRatio = skinPixels / totalPx
        const facesDetected = skinRatio > 0.20

        // Sky: top 25% of image, bright + blue/neutral
        const topQuarter = allLab.slice(0, Math.floor(totalPx * 0.25))
        const skyPixels = topQuarter.filter(p => p.L > 55 && p.a > -15 && p.a < 5 && p.b < 5).length
        const skyDetected = skyPixels / topQuarter.length > 0.3

        // Water: mid region, blue/teal
        const midRegion = allLab.slice(Math.floor(totalPx * 0.25), Math.floor(totalPx * 0.75))
        const waterPixels = midRegion.filter(p => p.a < -2 && p.b < 0 && p.L > 25 && p.L < 75).length
        const waterDetected = waterPixels / midRegion.length > 0.2

        // Green nature: significant green pixels
        const greenPixels = allLab.filter(p => p.a < -8 && p.L > 25).length
        const greenDetected = greenPixels / totalPx > 0.25

        // ── 8. Scene type ──
        // Portrait: needs high skin ratio AND no dominant sky/water/green (to avoid false positives with warm nature scenes)
        let sceneType = 'unknown'
        if (facesDetected && !skyDetected && !waterDetected && !greenDetected && skinRatio > 0.20) sceneType = 'portrait'
        else if (skyDetected && waterDetected) sceneType = 'seascape'
        else if (skyDetected && avgA < -5) sceneType = 'landscape'
        else if (skyDetected && avgB > 5) sceneType = 'landscape' // warm sky (sunset)
        else if (avgL < 35 && avgChroma < 20) sceneType = 'cityscape_night'
        else if (edgeDensity > 0.35 && !facesDetected) sceneType = 'architecture'
        else if (avgA < -10 && avgB > 5) sceneType = 'nature_green'
        else if (greenDetected) sceneType = 'nature_green'
        else if (avgA > 8 && avgB > 10 && avgL > 40) sceneType = 'nature_warm'
        else if (avgL > 72 && avgChroma < 12) sceneType = 'nature_snow'
        else if (avgChroma > 45) sceneType = 'abstract_colorful'
        // Only use facesDetected as last resort if really no other scene fits AND skin ratio is high
        else if (facesDetected && skinRatio > 0.25) sceneType = 'portrait'

        resolve({
          labZones,
          featureVector: {
            sceneType, textureLevel, edgeDensity: Math.round(edgeDensity * 100) / 100,
            brightnessRange, avgL: Math.round(avgL), avgChroma: Math.round(avgChroma),
            dominantColors, facesDetected, skyDetected, waterDetected, tileType
          }
        })
      }
      img.onerror = () => resolve({ labZones: [], featureVector: { sceneType: 'unknown', textureLevel: 'medium', edgeDensity: 0, brightnessRange: 'medium', avgL: 50, avgChroma: 0, dominantColors: [], facesDetected: false, skyDetected: false, waterDetected: false, tileType: 'medium' } })
      img.src = src
    })
  }, [])

  const runTestAnalysis = useCallback(async () => {
    if (!testImageUrl.trim() && !testImageFile) return
    setTestAnalyzing(true); setTestAnalysis(null)
    try {
      // Step 1: fal.ai Vision Analysis (Florence-2)
      let falResult: {
        ok: boolean; description?: string; sceneType?: string; hasFace?: boolean;
        faceCount?: number; attributes?: Record<string, boolean>;
        keywordSuggestions?: Array<{keyword: string; reason: string; priority: string}>;
        imageUrl?: string; error?: string;
      } | null = null

      if (testImageFile) {
        // Upload base64 to server for fal.ai analysis
        const falRes = await fetch('/api/analyze-image-fal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ imageBase64: testImageFile.base64.replace(/^data:[^;]+;base64,/, ''), mimeType: 'image/jpeg' }),
          signal: AbortSignal.timeout(45000),
        })
        falResult = await falRes.json()
        console.log('[Admin] fal.ai result:', falResult)
      } else if (testImageUrl.trim()) {
        // For URL: use Florence-2 directly via server proxy
        const falRes = await fetch('/api/analyze-image-fal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ imageUrl: testImageUrl.trim() }),
          signal: AbortSignal.timeout(45000),
        })
        falResult = await falRes.json()
      }

      // Step 2: Also compute LAB zones client-side for pool gap analysis
      let labZones: Array<{L: number; a: number; b: number; count: number}> = []
      let featureVector: { sceneType: string; textureLevel: string; edgeDensity: number; brightnessRange: string; avgL: number; avgChroma: number; dominantColors: string[]; facesDetected: boolean; skyDetected: boolean; waterDetected: boolean; tileType: string } = { sceneType: falResult?.sceneType ?? 'unknown', textureLevel: 'medium', edgeDensity: 0, brightnessRange: 'medium', avgL: 50, avgChroma: 0, dominantColors: [] as string[], facesDetected: falResult?.hasFace ?? false, skyDetected: false, waterDetected: false, tileType: 'medium' }
      // imageError only shown if fal.ai itself failed (Canvas LAB errors are non-critical)
      let imageError = (falResult && !falResult.ok) ? (falResult.error ?? 'fal.ai Analyse fehlgeschlagen') : ''
      const imageSrc = testImageFile ? testImageFile.base64 : testImageUrl.trim()
      try {
        const result = await computeLabZonesFromImage(imageSrc)
        labZones = result.labZones
        featureVector = { ...result.featureVector, dominantColors: (result.featureVector.dominantColors ?? []) as string[], sceneType: falResult?.sceneType ?? result.featureVector.sceneType, facesDetected: falResult?.hasFace ?? result.featureVector.facesDetected }
      } catch (e) {
        console.warn('[Admin] Canvas LAB analysis failed (non-critical):', e)
        // Not fatal – fal.ai result is the primary source
      }

      // Step 3: Server pool gap analysis
      // Pass detected category for context-aware keyword suggestions
      const detectedCat = falResult?.sceneType ?? (featureVector.sceneType !== 'unknown' ? featureVector.sceneType : undefined);
      const body = {
        imageUrl: testImageFile ? undefined : testImageUrl.trim(),
        labZones,
        imageError: imageError || undefined,
        category: detectedCat,
      }
      const res = await fetch('/api/trpc/analyzeTestImage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      const serverResult = data.result?.data?.json ?? data.result?.data

      // Merge fal.ai + LAB + server results
      const mergedKeywords = [
        ...(falResult?.keywordSuggestions ?? []),
        ...(serverResult?.keywordSuggestions ?? []),
      ].filter((k, i, arr) => arr.findIndex(x => x.keyword === k.keyword) === i).slice(0, 15)

      const analysisResult = {
        ...serverResult,
        featureVector,
        imageError: imageError || (falResult?.ok === false ? serverResult?.imageError : undefined),
        falDescription: falResult?.description,
        falSceneType: falResult?.sceneType,
        falAttributes: falResult?.attributes,
        keywordSuggestions: mergedKeywords,
      }
      setTestAnalysis(analysisResult)
      // Persist analysis to localStorage so Import-Tab can use it
      try {
        localStorage.setItem('mosaicprint_last_analysis', JSON.stringify({
          keywords: mergedKeywords,
          sceneType: falResult?.sceneType ?? featureVector.sceneType,
          timestamp: new Date().toISOString(),
        }))
      } catch { /* ignore storage errors */ }
      setDetectedCategory(falResult?.sceneType ?? (featureVector.sceneType !== 'unknown' ? featureVector.sceneType : detectCategory(labZones)))
    } catch (e) {
      onMessage({ text: `Analyse-Fehler: ${String(e)}`, type: 'error' })
    } finally { setTestAnalyzing(false) }
  }, [testImageUrl, testImageFile, computeLabZonesFromImage, detectCategory, onMessage])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Qualitätssicherung</h2>
          <p className="text-sm text-gray-500 mt-1">Manuelle und automatische Checks für Tile-Pool, Import-Pipeline und Algorithmus</p>
        </div>
        <div className="flex gap-3">
          <button onClick={downloadPdfReport} disabled={pdfGenerating}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors">
            {pdfGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {pdfGenerating ? 'Generiere...' : 'PDF-Report'}
          </button>
        </div>
      </div>

      {/* Gemini Bildanalyse & Dynamische Einstellungen (Admin-only) */}
      <GeminiAnalysisPanel />

      {/* Letztes Mosaik – Qualitätsanalyse */}
      <LastMosaicQualityPanel />
            {/* Test-Analyse */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-1">🧪 Testbild-Analyse</h3>
        <p className="text-sm text-gray-500 mb-4">Analysiert ein Bild gegen den Tile-Pool und zeigt fehlende Farbbereiche + Keyword-Vorschläge für Smart-Import.</p>

        {/* File upload preview */}
        {testImageFile && (
          <div className="flex items-center gap-3 mb-3 p-3 bg-indigo-50 border border-indigo-200 rounded-xl">
            <img src={testImageFile.preview} alt="Vorschau" className="w-12 h-12 rounded-lg object-cover border border-indigo-200" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-indigo-800 truncate">{testImageFile.name}</p>
              <p className="text-xs text-indigo-500">Datei geladen – bereit zur Analyse</p>
            </div>
            <button onClick={() => setTestImageFile(null)} className="text-indigo-400 hover:text-indigo-600 text-lg leading-none">&times;</button>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          {/* Hidden file input */}
          <input
            id="test-image-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            onChange={handleTestFileUpload}
          />
          {/* Upload button */}
          <label
            htmlFor="test-image-file-input"
            className="flex items-center gap-2 border border-gray-200 hover:border-indigo-400 bg-white text-gray-700 hover:text-indigo-700 font-medium px-4 py-2 rounded-xl text-sm cursor-pointer transition-colors shrink-0"
            title="JPG, PNG oder PDF hochladen"
          >
            <Upload className="w-4 h-4" />
            <span>Datei</span>
          </label>
          <input
            type="url"
            value={testImageUrl}
            onChange={e => { setTestImageUrl(e.target.value); setTestImageFile(null) }}
            placeholder={testImageFile ? `(${testImageFile.name})` : 'Bild-URL eingeben (z.B. https://images.unsplash.com/...)'}
            disabled={!!testImageFile}
            className="flex-1 border border-gray-200 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
          />
          <button onClick={runTestAnalysis} disabled={testAnalyzing || (!testImageUrl.trim() && !testImageFile)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors">
            {testAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {testAnalyzing ? 'Analysiere...' : 'Analysieren'}
          </button>
        </div>
        {/* Preset-Buttons */}
        <div className="flex flex-wrap gap-2 mb-4">
          <span className="text-xs text-gray-400 self-center shrink-0">Beispiele:</span>
          {[
            // Portraits – differenziert nach Hautton, Haarfarbe, Brille, Alter, Licht
            { label: '👩🏻 Haut hell / blond', url: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=400', cat: 'portrait' },
            { label: '👨🏾 Haut mittel / braun', url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400', cat: 'portrait' },
            { label: '👨🏿 Haut dunkel', url: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400', cat: 'portrait' },
            { label: '👩🏼 Haut oliv / dunkles Haar', url: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400', cat: 'portrait' },
            { label: '👨🏻 Brille / graues Haar', url: 'https://images.unsplash.com/photo-1552058544-f2b08422138a?w=400', cat: 'portrait' },
            { label: '👩🏽 Rotes Haar', url: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400', cat: 'portrait' },
            { label: '👶 Kind / Baby', url: 'https://images.unsplash.com/photo-1555252333-9f8e92e65df9?w=400', cat: 'portrait' },
            { label: '👴 Ältere Person', url: 'https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=400', cat: 'portrait' },
            { label: '👩 Gegenlicht / Silhouette', url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400', cat: 'portrait' },
            { label: '👨🏻 Gruppe / mehrere Personen', url: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=400', cat: 'portrait' },
            // Natur & Landschaft
            { label: '🌅 Sonnenuntergang', url: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=400', cat: 'natur' },
            { label: '🌊 Ozean', url: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=400', cat: 'natur' },
            { label: '🌲 Wald', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=400', cat: 'natur' },
            { label: '❄️ Schnee/Winter', url: 'https://images.unsplash.com/photo-1491002052546-bf38f186af56?w=400', cat: 'natur' },
            // Architektur & Stadt
            { label: '🏙️ Skyline Nacht', url: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=400', cat: 'stadt' },
            { label: '🏛️ Architektur', url: 'https://images.unsplash.com/photo-1486325212027-8081e485255e?w=400', cat: 'stadt' },
            // Tiere
            { label: '🦁 Löwe', url: 'https://images.unsplash.com/photo-1546182990-dffeafbe841d?w=400', cat: 'tier' },
            { label: '🦜 Vogel bunt', url: 'https://images.unsplash.com/photo-1444464666168-49d633b86797?w=400', cat: 'tier' },
            // Abstrakt / Farbe
            { label: '🎨 Farbenreich', url: 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=400', cat: 'farbe' },
          ].map(p => (
            <button key={p.label} onClick={() => { setTestImageUrl(p.url); setTestImageFile(null); }}
              className="px-3 py-1 rounded-full text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors">
              {p.label}
            </button>
          ))}
        </div>
        {!!testAnalysis && (
          <div className="space-y-4">
            {/* fal.ai Florence-2 Description */}
            {(() => {
              const falDesc = (testAnalysis as unknown as {falDescription?: string}).falDescription
              if (!falDesc) return null
              const falAttr = (testAnalysis as unknown as {falAttributes?: Record<string, boolean>}).falAttributes
              return (
                <div className="bg-violet-50 border border-violet-200 rounded-xl p-4">
                  <h4 className="text-sm font-bold text-violet-800 mb-2">🤖 KI-Bildbeschreibung (Florence-2)</h4>
                  <p className="text-xs text-violet-900 leading-relaxed">{falDesc}</p>
                  {falAttr && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Object.entries(falAttr).filter(([, v]) => v).map(([k]) => (
                        <span key={k} className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full text-xs font-medium">
                          {k === 'hasBeard' ? '🧔 Bart' : k === 'hasGlasses' ? '👓 Brille' : k === 'hasWhiteHair' ? '👴 Weißes Haar' : k === 'isNight' ? '🌃 Nacht' : k === 'isNature' ? '🌿 Natur' : k === 'isColorful' ? '🎨 Farbenreich' : k === 'isArchitecture' ? '🏛️ Architektur' : k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
            {/* Feature Vector */}
            {!!testAnalysis.featureVector && (<>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-blue-800 mb-3">🔬 Bild-Analyse (Feature-Vektor)</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Szenentyp</span>
                    <span className="text-blue-900 font-semibold capitalize">{(testAnalysis.featureVector as unknown as {sceneType: string}).sceneType.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Tile-Typ</span>
                    <span className={`font-semibold ${
                      (testAnalysis.featureVector as unknown as {tileType: string}).tileType === 'calm' ? 'text-green-700' :
                      (testAnalysis.featureVector as unknown as {tileType: string}).tileType === 'busy' ? 'text-red-700' : 'text-amber-700'
                    }`}>{(testAnalysis.featureVector as unknown as {tileType: string}).tileType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Textur</span>
                    <span className="text-blue-900">{(testAnalysis.featureVector as unknown as {textureLevel: string}).textureLevel} (Kanten: {(testAnalysis.featureVector as unknown as {edgeDensity: number}).edgeDensity})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Helligkeit</span>
                    <span className="text-blue-900">L={(testAnalysis.featureVector as unknown as {avgL: number}).avgL} · {(testAnalysis.featureVector as unknown as {brightnessRange: string}).brightnessRange}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Chroma</span>
                    <span className="text-blue-900">{(testAnalysis.featureVector as unknown as {avgChroma: number}).avgChroma}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Erkannt</span>
                    <span className="text-blue-900">
                      {(testAnalysis.featureVector as unknown as {facesDetected: boolean}).facesDetected && '👤 Gesicht '}
                      {(testAnalysis.featureVector as unknown as {skyDetected: boolean}).skyDetected && '☁️ Himmel '}
                      {(testAnalysis.featureVector as unknown as {waterDetected: boolean}).waterDetected && '🌊 Wasser '}
                      {!(testAnalysis.featureVector as unknown as {facesDetected: boolean; skyDetected: boolean; waterDetected: boolean}).facesDetected &&
                       !(testAnalysis.featureVector as unknown as {skyDetected: boolean}).skyDetected &&
                       !(testAnalysis.featureVector as unknown as {waterDetected: boolean}).waterDetected && '—'}
                    </span>
                  </div>
                </div>
                {((testAnalysis.featureVector as unknown as {dominantColors: string[]}).dominantColors?.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(testAnalysis.featureVector as unknown as {dominantColors: string[]}).dominantColors.map((c: string) => (
                      <span key={c} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">{c}</span>
                    ))}
                  </div>
                )}
              </div>
              {/* Profil-Speicher-Button */}
              {detectedCategory && (
                <div className="mt-3 pt-3 border-t border-blue-200 flex items-center justify-between">
                  <div className="text-xs text-blue-700">
                    <span className="font-medium">Erkannte Kategorie:</span>{' '}
                    <span className="bg-blue-100 px-2 py-0.5 rounded-full font-semibold">
                      {categories.find(c => c.name === detectedCategory)?.label ?? detectedCategory}
                    </span>
                  </div>
                  <button
                    onClick={() => saveProfileForCategory(detectedCategory)}
                    disabled={savingProfile}
                    className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  >
                    {savingProfile ? '⏳ Speichern...' : '💾 Algorithmus-Profil speichern'}
                  </button>
                </div>
              )}
              {!detectedCategory && (
                <div className="mt-3 pt-3 border-t border-blue-200">
                  <p className="text-xs text-blue-500">Keine Kategorie automatisch erkannt. Wähle manuell:</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {categories.slice(0, 8).map(cat => (
                      <button key={cat.name} onClick={() => saveProfileForCategory(cat.name)}
                        disabled={savingProfile}
                        className="px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 text-xs rounded-lg transition-colors disabled:opacity-50">
                        {cat.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
            )}
            {/* LAB Gap Analysis */}
            {(testAnalysis.gapZones as unknown[])?.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-amber-800 mb-2">⚠️ Fehlende Farbbereiche im Pool</h4>
                <div className="space-y-1">
                  {(testAnalysis.gapZones as Array<{zone: string; needed: number; available: number; deficit: number}>).map((z, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-amber-700 font-medium">{z.zone}</span>
                      <span className="text-amber-600">{z.available} vorhanden / {z.needed} benötigt (Defizit: {z.deficit})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Keyword Suggestions */}
            {(testAnalysis.keywordSuggestions as unknown[])?.length > 0 && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-indigo-800 mb-3">💡 Empfohlene Import-Keywords</h4>
                <div className="flex flex-wrap gap-2">
                  {(testAnalysis.keywordSuggestions as Array<{keyword: string; reason: string; priority: string}>).map((s, i) => (
                    <div key={i} className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                      s.priority === 'high' ? 'bg-red-50 border-red-200 text-red-700' :
                      s.priority === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                      'bg-gray-50 border-gray-200 text-gray-600'
                    }`}>
                      {s.keyword}
                      <span className="ml-1 opacity-60">– {s.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Smart Import Button */}
            {(testAnalysis.keywordSuggestions as unknown[])?.length > 0 && (
              <div className="bg-gradient-to-r from-violet-50 to-indigo-50 border border-violet-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-sm font-bold text-violet-800">🔍 Smart Import aus Analyse</h4>
                    <p className="text-xs text-violet-500 mt-0.5">Analyse wurde gespeichert – auch im <strong>Import-Tab</strong> verfügbar</p>
                  </div>
                  <select
                    value={analysisImportSource}
                    onChange={e => setAnalysisImportSource(e.target.value as 'pexels' | 'unsplash' | 'pixabay')}
                    className="text-xs border border-violet-200 rounded-lg px-2 py-1 bg-white text-violet-700"
                  >
                    <option value="pexels">Pexels</option>
                    <option value="unsplash">Unsplash</option>
                    <option value="pixabay">Pixabay</option>
                    <option value="flickr">Flickr</option>
                  </select>
                </div>
                <p className="text-xs text-violet-600 mb-3">
                  Importiert Bilder basierend auf den {(testAnalysis.keywordSuggestions as unknown[]).length} erkannten Keywords aus der Bildanalyse.
                  Jedes Keyword liefert ~30 Bilder.
                </p>
                <button
                  onClick={startAnalysisImport}
                  disabled={analysisImportRunning}
                  className="w-full py-2 px-4 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {analysisImportRunning ? (
                    <><span className="animate-spin">⏳</span> Import läuft...</>
                  ) : (
                    <><span>🚀</span> Import empfohlene Bilder ({(testAnalysis.keywordSuggestions as unknown[]).length * 30} Bilder)</>
                  )}
                </button>
                {analysisImportJob && (
                  <div className="mt-3 space-y-2">
                    {(analysisImportJob.total ?? 0) > 0 && (
                      <div className="w-full bg-violet-100 rounded-full h-2">
                        <div
                          className="bg-violet-500 h-2 rounded-full transition-all"
                          style={{ width: `${Math.min(100, ((analysisImportJob.imported ?? 0) / (analysisImportJob.total ?? 1)) * 100)}%` }}
                        />
                      </div>
                    )}
                    <div className="text-xs text-violet-700 font-medium">
                      {analysisImportJob.imported ?? 0} / {analysisImportJob.total ?? 0} Bilder importiert
                      {analysisImportJob.finishedAt && <span className="ml-2 text-green-600">✅ Fertig</span>}
                      {analysisImportJob.error && <span className="ml-2 text-red-600">❌ {typeof analysisImportJob.error === 'string' ? analysisImportJob.error : (analysisImportJob.error as any)?.message ?? JSON.stringify(analysisImportJob.error)}</span>}
                    </div>
                    {analysisImportJob.log.length > 0 && (
                      <div className="bg-white rounded-lg p-2 max-h-24 overflow-y-auto text-xs text-gray-500 font-mono">
                        {analysisImportJob.log.slice(-5).map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Auto-Optimize Panel */}
            <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-4">
              <button
                onClick={() => setAutoOptimizeExpanded(p => !p)}
                className="w-full flex items-center justify-between"
              >
                <h4 className="text-sm font-bold text-emerald-800">🎯 Auto-Optimize Loop</h4>
                <span className="text-emerald-500 text-xs">{autoOptimizeExpanded ? '▲ Einklappen' : '▼ Ausklappen'}</span>
              </button>
              {autoOptimizeExpanded && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-emerald-700">
                    Iterativer Hill-Climbing-Algorithmus: Testet LAB-Blend, Helligkeit, Textur, Kontrast und Overlay-Gewichte
                    und optimiert sie auf minimale DeltaE. Bis zu 10 Iterationen.
                  </p>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-emerald-700 font-medium whitespace-nowrap">Ziel DeltaE ≤</label>
                    <input
                      type="number"
                      value={autoOptimizeDeltaTarget}
                      onChange={e => setAutoOptimizeDeltaTarget(Number(e.target.value))}
                      min={5} max={30} step={1}
                      className="w-20 text-xs border border-emerald-200 rounded-lg px-2 py-1 bg-white text-emerald-800"
                    />
                    <span className="text-xs text-emerald-600">(Empfohlen: 10–15)</span>
                  </div>
                  <button
                    onClick={runAutoOptimize}
                    disabled={autoOptimizeRunning || !testAnalysis}
                    className="w-full py-2 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {autoOptimizeRunning ? (
                      <><span className="animate-spin">⚙️</span> Optimierung läuft...</>
                    ) : (
                      <><span>🎯</span> Auto-Optimize starten</>
                    )}
                  </button>
                  {autoOptimizeBestScore !== null && (
                    <div className={`text-sm font-bold px-3 py-2 rounded-lg ${
                      autoOptimizeBestScore <= autoOptimizeDeltaTarget ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      Beste DeltaE: {autoOptimizeBestScore}
                      {autoOptimizeBestScore <= autoOptimizeDeltaTarget ? ' ✅ Ziel erreicht!' : ` (Ziel: ≤${autoOptimizeDeltaTarget})`}
                    </div>
                  )}
                  {autoOptimizeLog.length > 0 && (
                    <div className="space-y-1">
                      <h5 className="text-xs font-bold text-emerald-700">Iterations-Verlauf:</h5>
                      <div className="bg-white rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">
                        {autoOptimizeLog.map((entry, i) => (
                          <div key={i} className={`text-xs flex items-center gap-2 px-2 py-1 rounded ${
                            entry.improved ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'
                          }`}>
                            <span className="font-mono w-12">#{entry.iter}</span>
                            <span className="font-bold">ΔE {entry.deltaE}</span>
                            {entry.improved && <span className="text-green-500">↑ verbessert</span>}
                            <span className="text-gray-400 text-xs ml-auto">
                              {Object.entries(entry.params).map(([k, v]) => `${k.replace('Weight','W')}=${v}`).join(' ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {autoOptimizeBestParams && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-emerald-600 hover:text-emerald-800">Optimierte Parameter anzeigen</summary>
                      <pre className="mt-2 bg-white rounded-lg p-2 overflow-auto text-gray-600">{JSON.stringify(autoOptimizeBestParams, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            {/* Raw summary */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-400 hover:text-gray-600">Rohdaten anzeigen</summary>
              <pre className="mt-2 bg-gray-50 rounded-lg p-3 overflow-auto text-gray-600 max-h-48">{JSON.stringify(testAnalysis, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>


      {/* Semantic Auto-Tagger entfernt – kein Mehrwert */}

      {/* ── KI-Bildanalyse (Gemini Vision Batch) ────────────────────────────────── */}
      <AiAnalysisPanel onMessage={onMessage} />

      {/* ── Bereinigungsassistent ──────────────────────────────────────────────────── */}
      <CleanupAssistant onMessage={onMessage} />

    </div>
  )
}

// ── Semantic Tagger Panel ────────────────────────────────────────────────

// ── Bereinigungsassistent ────────────────────────────────────────────────
type CleanupCategory = 'rejected' | 'poor' | 'urlDuplicates' | 'pixabayHotlink' | 'grayBusy' | 'nearWhite' | 'lowScore' | 'oversaturatedSkin' | 'portraitBusy'

interface CleanupTile {
  id: number
  thumbUrl: string | null
  sourceUrl: string | null
  avgL: number
  avgA: number
  avgB: number
  chroma: number
  tileType: string | null
  qualityScore: number | null
  qualityStatus: string | null
  photographerName: string | null
  importQuery: string | null
}

interface CleanupCandidates {
  totalActive: number
  themeDistribution: Array<{ theme: string; count: number; pct: number }>
  stage1: { rejected: number; poor: number; urlDuplicates: number; pixabayHotlink: number; total: number }
  stage2: { grayBusy: number; nearWhite: number; lowScore: number; total: number }
}

function CleanupAssistant({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const { authHeaders } = useAuth();
  const [expanded, setExpanded] = useState(false)
  const [candidates, setCandidates] = useState<CleanupCandidates | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [previewCategory, setPreviewCategory] = useState<CleanupCategory | null>(null)
  const [previewTiles, setPreviewTiles] = useState<CleanupTile[]>([])
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [confirmCategory, setConfirmCategory] = useState<CleanupCategory | null>(null)

  const fetchCandidates = useCallback(async () => {
    setLoadingCandidates(true)
    try {
      const res = await fetch('/api/trpc/getCleanupCandidates', { headers: authHeaders() })
      const data = await res.json()
      setCandidates(data.result?.data?.json ?? data.result?.data ?? null)
    } catch (e) {
      console.error('[CleanupAssistant] fetchCandidates failed:', e)
    }
    finally { setLoadingCandidates(false) }
  }, [authHeaders])

  useEffect(() => { if (expanded) fetchCandidates() }, [expanded, fetchCandidates])

  const fetchPreview = useCallback(async (cat: CleanupCategory) => {
    setPreviewCategory(cat)
    setPreviewTiles([])
    setSelectedIds(new Set())
    setLoadingPreview(true)
    try {
      const res = await fetch('/api/trpc/getCleanupPreview?input=' + encodeURIComponent(JSON.stringify({ category: cat, limit: 100 })), { headers: authHeaders() })
      const data = await res.json()
      // tRPC v11 kann Daten in verschiedenen Strukturen zurückgeben
      const raw = data.result?.data?.json ?? data.result?.data ?? data
      const tiles: CleanupTile[] = Array.isArray(raw?.tiles) ? raw.tiles : Array.isArray(raw) ? raw : []
      setPreviewTiles(tiles)
      // Default: alle ausgewählt
      setSelectedIds(new Set(tiles.map(t => t.id)))
    } catch (e) {
      onMessage({ text: `Vorschau-Fehler: ${String(e)}`, type: 'error' })
    }
    finally { setLoadingPreview(false) }
  }, [onMessage, authHeaders])

  const toggleTile = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDelete = useCallback(async (cat: CleanupCategory, ids?: number[]) => {
    setDeleting(true)
    setConfirmCategory(null)
    try {
      const body = ids ? { category: cat, ids, dryRun: false } : { category: cat, dryRun: false }
      const res = await fetch('/api/trpc/bulkDeleteTiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      const deleted: number = data.result?.data?.json?.deleted ?? data.result?.data?.deleted ?? 0
      onMessage({ text: `🗑️ ${deleted} Tiles gelöscht`, type: 'success' })
      // Aktualisieren
      fetchCandidates()
      if (previewCategory === cat) {
        setPreviewTiles(prev => prev.filter(t => !selectedIds.has(t.id)))
        setSelectedIds(new Set())
      }
    } catch (e) {
      onMessage({ text: `Fehler: ${String(e)}`, type: 'error' })
    }
    finally { setDeleting(false) }
  }, [onMessage, fetchCandidates, previewCategory, selectedIds])

  const categoryMeta: Record<CleanupCategory, { label: string; desc: string; stage: 1 | 2 | 3; color: string; icon: string }> = {
    rejected: { label: 'Abgelehnte Tiles', desc: 'quality_status = rejected – bereits aus Index gefiltert, aber noch in DB', stage: 1, color: 'red', icon: '❌' },
    poor: { label: 'Poor-Tiles (Gemini)', desc: 'ai_suitability = poor – von Gemini als wenig geeignet eingestuft', stage: 1, color: 'orange', icon: '⚠️' },
    urlDuplicates: { label: 'URL-Duplikate', desc: 'Gleiche source_url – nur niedrigste ID wird behalten', stage: 1, color: 'orange', icon: '🔁' },
    pixabayHotlink: { label: 'Pixabay ohne R2', desc: 'Pixabay-Tiles ohne R2-URL – Hotlink-geschützt, nicht mehr nutzbar', stage: 1, color: 'amber', icon: '🔒' },
    grayBusy: { label: 'Grau + Busy', desc: 'Chroma < 3 UND tile_type = busy – strukturlos und unruhig', stage: 2, color: 'gray', icon: '🌫️' },
    nearWhite: { label: 'Fast-Weiss', desc: 'L > 92 UND Chroma < 5 – kein Mehrwert für Mosaike', stage: 2, color: 'blue', icon: '⬜' },
    lowScore: { label: 'Tiefer Qualitäts-Score', desc: 'quality_score < 40 – schlechte Textur/Farbvielfalt', stage: 2, color: 'yellow', icon: '📉' },
    oversaturatedSkin: { label: 'Übersättigte Hauttöne', desc: 'Portrait-Theme UND Chroma > 35 – zu intensiv für Mosaike', stage: 3, color: 'pink', icon: '🎨' },
    portraitBusy: { label: 'Portrait-Tiles schwacher Qualität', desc: 'Portrait-Thema UND tile_type = busy UND quality_score < 55 – unruhig und unterdurchschnittlich', stage: 3, color: 'purple', icon: '🎭' },
  }

  const stageColors = { 1: 'bg-red-50 border-red-200', 2: 'bg-amber-50 border-amber-200', 3: 'bg-blue-50 border-blue-200' }
  const stageTitles = { 1: '🔴 Stufe 1 – Automatisch löschbar', 2: '🟡 Stufe 2 – Bulk-Delete mit Vorschau', 3: '🔵 Stufe 3 – Manuelles Review' }

  const countForCat = (cat: CleanupCategory): number => {
    if (!candidates) return 0
    if (cat === 'rejected') return candidates.stage1.rejected
    if (cat === 'poor') return candidates.stage1.poor ?? 0
    if (cat === 'urlDuplicates') return candidates.stage1.urlDuplicates
    if (cat === 'pixabayHotlink') return candidates.stage1.pixabayHotlink
    if (cat === 'grayBusy') return candidates.stage2.grayBusy
    if (cat === 'nearWhite') return candidates.stage2.nearWhite
    if (cat === 'lowScore') return candidates.stage2.lowScore
    return 0
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mt-6">
      {/* Header */}
      <div
        className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center text-xl">🧹</div>
          <div>
            <h3 className="font-bold text-gray-900">Bereinigungsassistent</h3>
            <p className="text-xs text-gray-500">
              Ungeeignete Tiles gezielt identifizieren und löschen – 2-stufiger Workflow mit Vorschau
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {candidates && (
            <span className="text-xs font-semibold bg-red-100 text-red-700 px-2 py-1 rounded-full">
              {candidates.stage1.total + candidates.stage2.total} Kandidaten
            </span>
          )}
          <span className="text-gray-400 text-sm">{expanded ? '▲ Einklappen' : '▼ Ausklappen'}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-5 space-y-6">
          {/* Kandidaten laden */}
          <div className="flex items-center gap-3">
            <button
              onClick={fetchCandidates}
              disabled={loadingCandidates}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm"
            >
              {loadingCandidates ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Kandidaten analysieren
            </button>
            {candidates && (
              <span className="text-sm text-gray-600">
                Gesamt: <strong>{candidates.stage1.total + candidates.stage2.total}</strong> Tiles
                ({candidates.stage1.total} auto · {candidates.stage2.total} bulk)
              </span>
            )}
          </div>

          {/* Pool-Statistik */}
          {candidates && candidates.themeDistribution && candidates.themeDistribution.length > 0 && (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
              <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wider mb-3">Pool-Verteilung ({candidates.totalActive.toLocaleString('de-CH')} aktive Tiles)</h4>
              <div className="space-y-1.5">
                {candidates.themeDistribution.map(t => (
                  <div key={t.theme} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 w-44 truncate shrink-0">{t.theme ?? '(kein Tag)'}</span>
                    <div className="flex-1 bg-gray-200 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-2 rounded-full ${t.pct > 30 ? 'bg-red-400' : t.pct > 15 ? 'bg-amber-400' : 'bg-blue-400'}`}
                        style={{ width: `${Math.min(t.pct, 100)}%` }}
                      />
                    </div>
                    <span className={`text-xs font-semibold w-10 text-right shrink-0 ${t.pct > 30 ? 'text-red-600' : t.pct > 15 ? 'text-amber-600' : 'text-gray-600'}`}>
                      {t.pct}%
                    </span>
                    <span className="text-xs text-gray-400 w-16 text-right shrink-0">{t.count.toLocaleString('de-CH')}</span>
                  </div>
                ))}
              </div>
              {candidates.themeDistribution.some(t => t.pct > 30) && (
                <p className="text-xs text-red-600 mt-2 font-medium">
                  ⚠️ Dominante Kategorie (&gt;30%) erkannt – Semantic Tagger neu ausführen empfohlen, um Pool-Verteilung zu korrigieren.
                </p>
              )}
            </div>
          )}

          {/* Stufen */}
          {([1, 2, 3] as const).map(stage => {
            const cats = (Object.entries(categoryMeta) as [CleanupCategory, typeof categoryMeta[CleanupCategory]][])
              .filter(([, m]) => m.stage === stage)
            return (
              <div key={stage} className={`rounded-xl border p-4 ${stageColors[stage]}`}>
                <h4 className="font-bold text-sm text-gray-800 mb-3">{stageTitles[stage]}</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {cats.map(([cat, meta]) => {
                    const count = countForCat(cat)
                    return (
                      <div key={cat} className="bg-white rounded-xl border border-gray-200 p-3">
                        <div className="flex items-start justify-between mb-1">
                          <div>
                            <span className="font-semibold text-sm text-gray-900">{meta.icon} {meta.label}</span>
                            <p className="text-xs text-gray-500 mt-0.5">{meta.desc}</p>
                          </div>
                          <span className={`text-sm font-bold ml-2 shrink-0 ${count > 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {candidates ? count.toLocaleString() : '–'}
                          </span>
                        </div>
                        {count > 0 && (
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => fetchPreview(cat)}
                              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg transition-colors font-medium"
                            >
                              👁️ Vorschau ({Math.min(count, 100)})
                            </button>
                            {stage === 1 && (
                              <button
                                onClick={() => setConfirmCategory(cat)}
                                disabled={deleting}
                                className="text-xs bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
                              >
                                🗑️ Alle löschen
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Bestätigungs-Dialog */}
          {confirmCategory && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
                <h3 className="font-bold text-lg text-gray-900 mb-2">Tiles löschen?</h3>
                <p className="text-sm text-gray-600 mb-4">
                  <strong>{countForCat(confirmCategory).toLocaleString()} Tiles</strong> der Kategorie
                  &ldquo;{categoryMeta[confirmCategory].label}&rdquo; werden unwiderruflich gelöscht.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => handleDelete(confirmCategory)}
                    disabled={deleting}
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-2 rounded-xl transition-colors"
                  >
                    {deleting ? 'Löschen...' : 'Ja, löschen'}
                  </button>
                  <button
                    onClick={() => setConfirmCategory(null)}
                    className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 rounded-xl transition-colors"
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Vorschau-Grid */}
          {previewCategory && (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="font-semibold text-sm text-gray-900">
                    {categoryMeta[previewCategory].icon} {categoryMeta[previewCategory].label}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {previewTiles.length} Tiles · {selectedIds.size} ausgewählt
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedIds(new Set(previewTiles.map(t => t.id)))}
                    className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 rounded-lg"
                  >
                    Alle wählen
                  </button>
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 rounded-lg"
                  >
                    Keine
                  </button>
                  <button
                    onClick={() => handleDelete(previewCategory, Array.from(selectedIds))}
                    disabled={deleting || selectedIds.size === 0}
                    className="text-xs bg-red-500 hover:bg-red-600 disabled:bg-gray-300 text-white font-semibold px-3 py-1 rounded-lg transition-colors"
                  >
                    {deleting ? 'Löschen...' : `🗑️ ${selectedIds.size} löschen`}
                  </button>
                  <button
                    onClick={() => { setPreviewCategory(null); setPreviewTiles([]) }}
                    className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 rounded-lg"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {loadingPreview ? (
                <div className="flex items-center justify-center h-32 text-gray-400">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Lade Vorschau...
                </div>
              ) : (
                <div className="p-3 grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-1.5 max-h-96 overflow-y-auto">
                  {previewTiles.map(tile => (
                    <div
                      key={tile.id}
                      onClick={() => toggleTile(tile.id)}
                      className={`relative cursor-pointer rounded-lg overflow-hidden aspect-square border-2 transition-all ${
                        selectedIds.has(tile.id) ? 'border-red-500 opacity-100' : 'border-transparent opacity-40'
                      }`}
                      title={`ID:${tile.id} | L:${tile.avgL.toFixed(0)} C:${tile.chroma} | ${tile.tileType ?? '–'} | ${tile.importQuery ?? ''}`}
                    >
                      {tile.thumbUrl ? (
                        <img
                          src={tile.thumbUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={e => {
                            const el = e.currentTarget;
                            el.style.display = 'none';
                            const fb = el.nextElementSibling as HTMLElement | null;
                            if (fb) fb.style.display = 'block';
                          }}
                        />
                      ) : null}
                      <div
                        className="w-full h-full"
                        style={{
                          background: `lab(${tile.avgL}% ${tile.avgA} ${tile.avgB})`,
                          display: tile.thumbUrl ? 'none' : 'block',
                        }}
                      />
                      {selectedIds.has(tile.id) && (
                        <div className="absolute top-0.5 right-0.5 w-3 h-3 bg-red-500 rounded-full" />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {previewTiles.length > 0 && (
                <div className="bg-gray-50 border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
                  Klick = auswählen/abwählen · Rot = wird gelöscht · Grau = wird behalten
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── KI-Bildanalyse Panel (Gemini Vision Batch) ───────────────────────────
function AiAnalysisPanel({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const { authHeaders } = useAuth();
  const [open, setOpen] = useState(true)
  const [running, setRunning] = useState(false)
  const [batchSize, setBatchSize] = useState(100)
  const [forceReanalyze, setForceReanalyze] = useState(false)
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const [stats, setStats] = useState<any>(null)
  const [lastResult, setLastResult] = useState<{ processed: number; rejected: number; errors: number; message: string } | null>(null)

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/admin/ai-analyze-stats', { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setStats(data.stats)
    } catch { /* ignore */ }
  }

  useEffect(() => { fetchStats() }, [authHeaders])

  const pollJobStatus = (intervalRef: { id: ReturnType<typeof setInterval> | null }) => {
    intervalRef.id = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/ai-analyze-job-status', { headers: authHeaders() })
        const data = await res.json()
        const state = data.state
        if (state) {
          setProgress({ processed: state.processed ?? 0, total: state.total ?? 0 })
          if (!state.running) {
            if (intervalRef.id) clearInterval(intervalRef.id)
            setProgress(null)
            setRunning(false)
            fetchStats()
            onMessage({ text: `✅ KI-Analyse abgeschlossen: ${state.processed ?? 0} analysiert, ${state.rejected ?? 0} rejected`, type: 'success' })
          }
        }
      } catch { /* ignore */ }
    }, 2000)
  }
  const startAnalysis = async () => {
    setRunning(true)
    setProgress({ processed: 0, total: 0 })
    setLastResult(null)
    const intervalRef: { id: ReturnType<typeof setInterval> | null } = { id: null }
    try {
      const res = await fetch('/api/admin/ai-analyze-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ batchSize, forceReanalyze }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Update progress from initial state if available
      if (data.state) {
        setProgress({ processed: data.state.processed ?? 0, total: data.state.total ?? 0 })
      }
      // Poll for progress updates (works for both new and already-running jobs)
      pollJobStatus(intervalRef)
    } catch (err) {
      if (intervalRef.id) clearInterval(intervalRef.id)
      onMessage({ text: `❌ KI-Analyse fehlgeschlagen: ${String(err)}`, type: 'error' })
      setRunning(false)
    }
  }

  const analyzed = Number(stats?.analyzed ?? 0)
  const total = Number(stats?.total ?? 0)
  const pct = total > 0 ? Math.round((analyzed / total) * 100) : 0
  const pending = Number(stats?.pending_with_r2 ?? 0)

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-3">
          <span className="text-xl">🤖</span>
          <div>
            <h3 className="font-bold text-gray-900">KI-Bildanalyse – Gemini Vision</h3>
            <p className="text-sm text-gray-500">
              Analysiert Tiles mit Google Gemini: Eignung für Mosaike, Gesichtserkennung, Wasserzeichen, präzises Thema.
              {stats && <span className="ml-2 font-medium text-blue-600">{analyzed.toLocaleString()} / {total.toLocaleString()} analysiert ({pct}%)</span>}
            </p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲ Einklappen' : '▼ Ausklappen'}</span>
      </div>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-gray-100">

          {/* Fortschrittsbalken */}
          {progress && (
            <div className="mt-4">
              <div className="flex justify-between text-sm text-gray-600 mb-1">
                <span>Analysiere... {progress.processed} / {progress.total} Tiles</span>
                <span>{progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-500 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {/* Letztes Ergebnis */}
          {lastResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
              ✅ {lastResult.message}
              {lastResult.rejected > 0 && <span className="ml-2 text-red-600">· {lastResult.rejected} als ungeeignet markiert</span>}
              {lastResult.errors > 0 && <span className="ml-2 text-yellow-600">· {lastResult.errors} Fehler</span>}
            </div>
          )}

          {/* Statistik */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
              {[
                { label: 'Analysiert', value: analyzed.toLocaleString(), color: 'blue' },
                { label: 'Ausstehend (mit R2)', value: pending.toLocaleString(), color: pending > 0 ? 'yellow' : 'green' },
                { label: '✅ Excellent', value: Number(stats.excellent ?? 0).toLocaleString(), color: 'green' },
                { label: '👍 Good', value: Number(stats.good ?? 0).toLocaleString(), color: 'blue' },
                { label: '⚠️ Poor', value: Number(stats.poor ?? 0).toLocaleString(), color: 'yellow' },
                { label: '❌ Reject', value: Number(stats.rejected_ai ?? 0).toLocaleString(), color: 'red' },
                { label: '👤 Gesichter', value: Number(stats.has_face ?? 0).toLocaleString(), color: 'purple' },
                { label: '🔏 Wasserzeichen', value: Number(stats.watermark ?? 0).toLocaleString(), color: 'red' },
              ].map(({ label, value, color }) => (
                <div key={label} className={`bg-${color}-50 border border-${color}-200 rounded-lg p-3 text-center`}>
                  <div className={`text-xl font-bold text-${color}-700`}>{value}</div>
                  <div className="text-xs text-gray-600 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Analyse-Optionen */}
          <div className="flex flex-wrap items-center gap-4 mt-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-700 font-medium">Batch-Grösse:</label>
              <select
                value={batchSize}
                onChange={e => setBatchSize(Number(e.target.value))}
                className="text-sm border border-gray-300 rounded px-2 py-1"
                disabled={running}
              >
                <option value={50}>50 Tiles (~$0.004)</option>
                <option value={100}>100 Tiles (~$0.008)</option>
                <option value={200}>200 Tiles (~$0.015)</option>
                <option value={500}>500 Tiles (~$0.038)</option>
                <option value={1000}>1'000 Tiles (~$0.075)</option>
                <option value={5000}>5'000 Tiles (~$0.38)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={forceReanalyze}
                onChange={e => setForceReanalyze(e.target.checked)}
                disabled={running}
              />
              Bereits analysierte Tiles neu analysieren
            </label>
          </div>

          <div className="flex gap-3 mt-2">
            <button
              onClick={startAnalysis}
              disabled={running}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors"
            >
              {running ? (
                <><span className="animate-spin">⟳</span> Analysiere...</>
              ) : (
                <><span>🤖</span> KI-Analyse starten</>
              )}
            </button>
            <button
              onClick={fetchStats}
              disabled={running}
              className="text-sm text-gray-600 hover:text-gray-900 border border-gray-300 px-3 py-2 rounded-lg"
            >
              ↻ Statistik aktualisieren
            </button>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 mt-2">
            <strong>Wie es funktioniert:</strong> Gemini Vision 2.0 Flash analysiert jedes Tile-Bild (128px) und bewertet:
            Mosaic-Eignung (excellent/good/poor/reject), Gesichtserkennung, Wasserzeichen, Thema und ob das Tile ruhig oder unruhig ist.
            Die Ergebnisse werden in der DB gespeichert und direkt vom Matching-Algorithmus und Bereinigungsassistenten verwendet.
            Kosten: ~$0.075 pro 1'000 Tiles (Gemini 2.0 Flash).
          </div>
        </div>
      )}
    </div>
  )
}

// ── Orders Panel (Kundenbestellungen) ────────────────────────────────────────
interface OrderItem {
  id: number
  order_type: string
  format_label: string
  material_label: string
  price_chf: number
  customer_email: string | null
  status: string
  download_token: string | null
  admin_notes: string | null
  render_params: Record<string, any> | null
  created_at: string
  paid_at: string | null
}

function OrdersPanel({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const { authHeaders } = useAuth();
  const [orders, setOrders] = useState<OrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [renderingId, setRenderingId] = useState<number | null>(null)
  const [renderProgress, setRenderProgress] = useState(0)
  const [renderMsg, setRenderMsg] = useState('')

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/orders', { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setOrders(data.orders ?? [])
    } catch {
      onMessage({ text: 'Fehler beim Laden der Bestellungen', type: 'error' })
    } finally { setLoading(false) }
  }, [onMessage])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  const updateStatus = async (id: number, status: string) => {
    try {
      await fetch(`/api/admin/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status }),
      })
      fetchOrders()
      onMessage({ text: `Bestellung #${id} auf "${status}" gesetzt`, type: 'success' })
    } catch {
      onMessage({ text: 'Fehler beim Aktualisieren', type: 'error' })
    }
  }

  const updateNotes = async (id: number, notes: string) => {
    try {
      await fetch(`/api/admin/orders/${id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ notes }),
      })
    } catch { /* silent */ }
  }

  const renderAndDownload = async (order: OrderItem) => {
    if (!order.render_params) {
      onMessage({ text: 'Keine Render-Parameter vorhanden', type: 'error' })
      return
    }
    setRenderingId(order.id)
    setRenderProgress(5)
    setRenderMsg('Starte Render...')

    const jobId = `admin-order-${order.id}-${Date.now()}`
    let sseSource: EventSource | null = null
    try {
      sseSource = new EventSource(`/api/print-progress/${jobId}`)
      sseSource.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data)
          if (d.progress) setRenderProgress(d.progress)
          if (d.message) setRenderMsg(d.message)
        } catch { /* ignore */ }
      }
    } catch { /* SSE not critical */ }

    try {
      const rp = order.render_params
      const resp = await fetch('/api/print-render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          tileIds: rp.tileIds,
          assignment: rp.assignment,
          cols: rp.cols,
          rows: rp.rows,
          tilePx: rp.tilePx ?? 200,
          format: 'jpg',
          jobId,
          overlayMode: rp.overlayMode ?? 'softlight',
          baseOverlay: rp.baseOverlay ?? 0.15,
          edgeBoost: rp.edgeBoost ?? 0.20,
          targetColors: rp.targetColors ?? [],
          edgeMap: rp.edgeMap ?? [],
          faceMask: rp.faceMask ?? [],
        }),
      })
      if (sseSource) sseSource.close()
      if (!resp.ok) throw new Error(`Render failed: ${resp.status}`)
      const { token, filename } = await resp.json()

      // Download the file
      const dlLink = document.createElement('a')
      dlLink.href = `/api/print-download/${token}?filename=${encodeURIComponent(filename)}`
      dlLink.download = filename
      dlLink.style.display = 'none'
      document.body.appendChild(dlLink)
      dlLink.click()
      setTimeout(() => document.body.removeChild(dlLink), 2000)

      onMessage({ text: `Bestellung #${order.id}: Download gestartet`, type: 'success' })
    } catch (e) {
      onMessage({ text: `Render-Fehler: ${e}`, type: 'error' })
    } finally {
      if (sseSource) sseSource.close()
      setRenderingId(null)
      setRenderProgress(0)
      setRenderMsg('')
    }
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    ready: 'bg-blue-100 text-blue-800',
    paid: 'bg-green-100 text-green-800',
    ordered: 'bg-purple-100 text-purple-800',
    shipped: 'bg-indigo-100 text-indigo-800',
    completed: 'bg-gray-100 text-gray-600',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Kundenbestellungen</h2>
          <p className="text-sm text-gray-500">{orders.length} Bestellung{orders.length !== 1 ? 'en' : ''}</p>
        </div>
        <button onClick={fetchOrders} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Aktualisieren
        </button>
      </div>

      {loading && orders.length === 0 && (
        <div className="text-center py-12 text-gray-400">Lade Bestellungen...</div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-gray-200">
          <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">Noch keine Bestellungen</p>
          <p className="text-gray-400 text-sm mt-1">Kundenbestellungen erscheinen hier, sobald ein Kunde "Bei Printolino bestellen" klickt.</p>
        </div>
      )}

      {orders.map(order => (
        <div key={order.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 sm:p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-bold text-gray-900">#{order.id}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColors[order.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {order.status}
                  </span>
                  {order.order_type === 'printolino' && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">Printolino</span>
                  )}
                </div>
                <p className="text-sm text-gray-600">{order.format_label} / {order.material_label}</p>
                {order.customer_email && (
                  <p className="text-xs text-gray-400 mt-0.5">{order.customer_email}</p>
                )}
              </div>
              <div className="text-right">
                <p className="font-bold text-orange-700">CHF {order.price_chf?.toFixed(2) ?? '0.00'}</p>
                <p className="text-xs text-gray-400">{new Date(order.created_at).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>

            {/* Render progress bar */}
            {renderingId === order.id && (
              <div className="mb-3">
                <div className="w-full bg-gray-200 rounded-full h-2 mb-1">
                  <div className="bg-indigo-600 h-2 rounded-full transition-all" style={{ width: `${renderProgress}%` }} />
                </div>
                <p className="text-xs text-gray-500">{renderMsg}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
              {order.render_params && (
                <button
                  onClick={() => renderAndDownload(order)}
                  disabled={renderingId !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Druckdatei herunterladen
                </button>
              )}

              {/* Status buttons */}
              {order.status === 'pending' && (
                <button onClick={() => updateStatus(order.id, 'ordered')} className="px-3 py-1.5 bg-purple-100 text-purple-700 text-xs font-semibold rounded-lg hover:bg-purple-200">
                  Als "bestellt" markieren
                </button>
              )}
              {order.status === 'ready' && (
                <button onClick={() => updateStatus(order.id, 'ordered')} className="px-3 py-1.5 bg-purple-100 text-purple-700 text-xs font-semibold rounded-lg hover:bg-purple-200">
                  Bei Printolino bestellt
                </button>
              )}
              {(order.status === 'ordered' || order.status === 'ready') && (
                <button onClick={() => updateStatus(order.id, 'shipped')} className="px-3 py-1.5 bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-lg hover:bg-indigo-200">
                  Versendet
                </button>
              )}
              {order.status === 'shipped' && (
                <button onClick={() => updateStatus(order.id, 'completed')} className="px-3 py-1.5 bg-green-100 text-green-700 text-xs font-semibold rounded-lg hover:bg-green-200">
                  Abgeschlossen
                </button>
              )}

              {/* Admin notes */}
              <input
                type="text"
                placeholder="Notiz..."
                defaultValue={order.admin_notes ?? ''}
                onBlur={(e) => updateNotes(order.id, e.target.value)}
                className="flex-1 min-w-[150px] px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 outline-none"
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
