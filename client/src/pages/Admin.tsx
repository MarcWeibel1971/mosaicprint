import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Database, RefreshCw, Upload, Image, Save, CheckCircle, XCircle,
  Zap, Camera, Settings, Grid, BarChart2, Filter, ChevronLeft, ChevronRight, Trash2, X, Download
} from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Upgrade a tile URL to a higher-resolution preview URL */
function getHighResUrl(url: string, size = 600): string {
  if (!url) return url
  // Picsum: https://picsum.photos/id/123/128/128 -> /id/123/600/600
  const picsumMatch = url.match(/picsum\.photos\/id\/([^/]+)\/\d+\/\d+/)
  if (picsumMatch) return `https://picsum.photos/id/${picsumMatch[1]}/${size}/${size}`
  // Unsplash: replace w= and h= params
  if (url.includes('images.unsplash.com')) {
    return url.replace(/&?w=\d+/g, `&w=${size}`).replace(/&?h=\d+/g, `&h=${size}`)
  }
  // Pexels: replace or add w= and h= params for higher resolution
  if (url.includes('images.pexels.com')) {
    const base = url.replace(/[&?]w=\d+/g, '').replace(/[&?]h=\d+/g, '')
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}w=${size}&h=${size}&fit=crop`
  }
  return url
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface DbStats { total: number; labIndexed: number; notIndexed: number }
interface ApiKeyStatus { stripe: boolean; unsplash: boolean; pexels: boolean }
interface ImportJob {
  running: boolean; imported?: number; total?: number
  log: string[]; error?: string | null; finishedAt?: string | null
}
interface TileImage {
  id: number; sourceUrl: string; tile128Url: string
  avgL: number; avgA: number; avgB: number
  createdAt: string; sourceId: string
  colorCategory: string | null; brightnessCategory: string | null
  subject: string | null
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
}
interface CronStatus {
  enabled: boolean; current: number; target: number; remaining: number; intervalHours: number
}
interface SmartImportJob {
  running: boolean; imported?: number; total?: number
  log: string[]; error?: string | null; finishedAt?: string | null
}

// ── Algorithm settings stored in localStorage ─────────────────────────────────
const SETTINGS_KEY = 'mosaicprint_algo_settings'
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
}
const DEFAULT_SETTINGS: AlgoSettings = {
  baseTiles: 80,      // 80 columns = good detail, manageable load
  tilePx: 12,         // 12px display tiles (loaded at 64px, downscaled)
  baseOverlay: 0.15,  // 15% overlay – needed for portrait visibility
  edgeBoost: 0.20,    // extra overlay at edges/contours (max 35% at sharp edges)
  neighborRadius: 4,
  neighborPenalty: 160,
  hiResPx: 200,
  hiResThreshold: 1.2,
  labWeight: 0.40,
  brightnessWeight: 0.30,
  textureWeight: 0.10,
  edgeWeight: 0.20,
  enableRotation: true,
  histogramBlend: 0.10,    // 0.10 = 65% LAB color transfer strength (portrait-optimized default)
  contrastBoost: 1.30,     // 30% contrast boost for matching
  overlayMode: 'alpha' as const,  // alpha blending (strongest portrait visibility)
}

function loadSettings(): AlgoSettings {
  try {
    const s = localStorage.getItem(SETTINGS_KEY)
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : { ...DEFAULT_SETTINGS }
  } catch { return { ...DEFAULT_SETTINGS } }
}
function saveSettings(s: AlgoSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
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

// ── Main Component ────────────────────────────────────────────────────────────
export default function Admin() {
  const [activeTab, setActiveTab] = useState<'import' | 'database' | 'settings'>('import')
  const [stats, setStats] = useState<DbStats | null>(null)
  const [apiKeys, setApiKeys] = useState<ApiKeyStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [activeJob, setActiveJob] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<Record<string, ImportJob>>({})
  const [cronStatus, setCronStatus] = useState<CronStatus | null>(null)
  const [smartJob, setSmartJob] = useState<SmartImportJob | null>(null)
  const [smartSource, setSmartSource] = useState<'unsplash' | 'pexels'>('pexels')
  const [importAllBatch, setImportAllBatch] = useState(500)
  const [importAllRunning, setImportAllRunning] = useState(false)
  // Gezielte Importe (Empfehlungen)
  interface ImportRecommendation { query: string; label: string; priority: number; deficit: number; subject: string }
  const [recommendations, setRecommendations] = useState<ImportRecommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [recsJob, setRecsJob] = useState<SmartImportJob | null>(null)
  const [recsSource, setRecsSource] = useState<'unsplash' | 'pexels' | 'shutterstock'>('pexels')
  const [selectedRecs, setSelectedRecs] = useState<Set<string>>(new Set())
  const [recsExpanded, setRecsExpanded] = useState(false)

  const fetchCronStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getCronStatus')
      const data = await res.json()
      setCronStatus(data.result?.data?.json ?? data.result?.data ?? data)
    } catch { /* ignore */ }
  }, [])

  const startSmartImport = async (sourceId: 'unsplash' | 'pexels') => {
    if (activeJob) return
    setActiveJob(`smart_${sourceId}`)
    setSmartJob({ running: true, log: [], imported: 0, total: 0 })
    setMessage({ text: `Smart-Import von ${sourceId} gestartet...`, type: 'info' })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`/api/trpc/getImportRecommendations?input=${params}`)
      const data = await res.json()
      const result = data.result?.data ?? data
      setRecommendations(result.tasks ?? [])
      // Select all by default
      setSelectedRecs(new Set((result.tasks ?? []).map((t: { query: string }) => t.query)))
    } catch { /* ignore */ } finally {
      setRecsLoading(false)
    }
  }, [])

  const startRecsImport = async () => {
    if (activeJob) return
    const queriesToRun = recommendations.filter(r => selectedRecs.has(r.query))
    if (queriesToRun.length === 0) return
    // Use smart_ prefix so existing polling useEffect picks it up automatically
    const jobKey = `smart_${recsSource}`
    setActiveJob(jobKey)
    setRecsJob({ running: true, log: [`🚀 Starte ${queriesToRun.length} Empfehlungen via ${recsSource}...`], imported: 0, total: queriesToRun.length * 80 })
    setMessage({ text: `Gezielte Importe gestartet: ${queriesToRun.length} Kategorien via ${recsSource}`, type: 'info' })
    try {
      await fetch('/api/trpc/smartImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: recsSource, count: queriesToRun.length * 80, targetPerBucket: 200 }),
      })
    } catch {
      setActiveJob(null)
      setMessage({ text: 'Fehler beim Starten der gezielten Importe', type: 'error' })
    }
  }

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const [statsRes, keysRes] = await Promise.all([
        fetch('/api/trpc/getTileStats'),
        fetch('/api/trpc/getApiKeyStatus'),
      ])
      const statsData = await statsRes.json()
      const keysData = await keysRes.json()
      setStats(statsData.result?.data?.json ?? statsData.result?.data ?? statsData)
      setApiKeys(keysData.result?.data?.json ?? keysData.result?.data ?? keysData)
    } catch {
      setMessage({ text: 'Fehler beim Laden der Statistiken', type: 'error' })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])
  useEffect(() => { fetchCronStatus() }, [fetchCronStatus])
  useEffect(() => { fetchRecommendations() }, [fetchRecommendations])

  // Poll import job status
  useEffect(() => {
    if (!activeJob) return
    const interval = setInterval(async () => {
      try {
        const params = encodeURIComponent(JSON.stringify({ sourceId: activeJob }))
        const res = await fetch(`/api/trpc/getImportStatus?input=${params}`)
        const data = await res.json()
        const job: ImportJob = data.result?.data ?? data
        setImportProgress(prev => ({ ...prev, [activeJob]: job }))
        if (!job.running && job.finishedAt) {
          setActiveJob(null)
          fetchStats()
          if (job.error) setMessage({ text: `Fehler: ${job.error}`, type: 'error' })
          else setMessage({ text: `Import abgeschlossen: ${job.imported ?? 0} neue Bilder importiert`, type: 'success' })
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeJob, fetchStats])

  // Poll smart import status (also used by Gezielte Importe / recs import)
  useEffect(() => {
    if (!activeJob?.startsWith('smart_')) return
    const sourceId = activeJob.replace('smart_', '')
    const interval = setInterval(async () => {
      try {
        const params = encodeURIComponent(JSON.stringify({ sourceId }))
        const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`)
        const data = await res.json()
        const job: SmartImportJob = data.result?.data ?? data
        setSmartJob(job)
        // Also update recsJob if it's running (Gezielte Importe uses same endpoint)
        setRecsJob(prev => prev?.running ? job : prev)
        if (!job.running && job.finishedAt) {
          setActiveJob(null)
          fetchStats()
          fetchCronStatus()
          fetchRecommendations() // Refresh recommendations after import
          if (job.error) setMessage({ text: `Fehler: ${job.error}`, type: 'error' })
          else setMessage({ text: `Import abgeschlossen: ${job.imported ?? 0} neue Bilder importiert`, type: 'success' })
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeJob, fetchStats, fetchCronStatus, fetchRecommendations])

  const startImport = async (sourceId: string, batchSize: number) => {
    if (activeJob) return
    setActiveJob(sourceId)
    setMessage({ text: `Import von ${sourceId} gestartet (${batchSize} Bilder, diverse Keywords)...`, type: 'info' })
    setImportProgress(prev => ({ ...prev, [sourceId]: { running: true, log: [], imported: 0, total: batchSize } }))
    try {
      await fetch('/api/trpc/importFromSource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sourceId as 'pexels' | 'unsplash' | 'shutterstock', count: batchSize }),
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: importAllBatch }),
      })
      const data = await res.json()
      const result = data.result?.data?.json ?? data.result?.data ?? data
      if (result.sources) {
        result.sources.forEach((src: string) => {
          setActiveJob(src)
          setImportProgress(prev => ({ ...prev, [src]: { running: true, log: [], imported: 0, total: importAllBatch } }))
        })
        setMessage({ text: `${result.sources.join(' + ')} gleichzeitig gestartet!`, type: 'success' })
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
    setMessage({ text: 'LAB-Indexierung gestartet...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/indexLabColors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      setMessage({ text: `LAB-Indexierung abgeschlossen: ${parsed?.indexed ?? 0} Bilder indexiert`, type: 'success' })
      fetchStats()
    } catch {
      setMessage({ text: 'Fehler bei der LAB-Indexierung', type: 'error' })
    } finally { setActiveJob(null) }
  }

  const handleExportSeed = async () => {
    if (activeJob) return
    setActiveJob('seed')
    setMessage({ text: 'Seed wird exportiert...', type: 'info' })
    try {
      const res = await fetch('/api/trpc/exportSeed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      })
      const data = await res.json()
      const parsed = data.result?.data?.json ?? data.result?.data ?? data
      setMessage({ text: `Seed exportiert: ${parsed?.exported ?? 0} Bilder gespeichert. Jetzt Git-Commit erstellen!`, type: 'success' })
    } catch {
      setMessage({ text: 'Fehler beim Seed-Export', type: 'error' })
    } finally { setActiveJob(null) }
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
          <div className="flex gap-6 mt-4">
            <div className="text-center">
              <div className="text-2xl font-bold">{(stats?.total ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">Bilder gesamt</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">{(stats?.labIndexed ?? 0).toLocaleString()}</div>
              <div className="text-xs text-gray-400">LAB-indexiert</div>
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
              { id: 'import', label: 'Import & Verwaltung', icon: Upload },
              { id: 'database', label: 'Datenbank', icon: Grid },
              { id: 'settings', label: 'Algorithmus', icon: Settings },
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

        {/* ── TAB: Import & Verwaltung ── */}
        {activeTab === 'import' && (
          <div className="space-y-8">
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
                  { key: 'shutterstock', label: 'Shutterstock', active: (apiKeys as any)?.shutterstock },
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

            {/* Cron Job Status */}
            {cronStatus && (
              <div className={`bg-white rounded-2xl p-5 border ${cronStatus.enabled ? 'border-indigo-200' : 'border-green-200'}`}>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-bold text-gray-900 flex items-center gap-2">
                    <RefreshCw className={`w-5 h-5 ${cronStatus.enabled ? 'text-indigo-500' : 'text-green-500'}`} />
                    Automatischer Import (stündlicher Cron-Job)
                  </h2>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${cronStatus.enabled ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
                    {cronStatus.enabled ? 'Aktiv' : 'Ziel erreicht ✓'}
                  </span>
                </div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{cronStatus.current.toLocaleString()} Bilder</span>
                      <span>Ziel: {cronStatus.target.toLocaleString()}</span>
                    </div>
                    <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${cronStatus.enabled ? 'bg-indigo-400' : 'bg-green-400'}`}
                        style={{ width: `${Math.min(100, Math.round((cronStatus.current / cronStatus.target) * 100))}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-2xl font-bold text-gray-900">{Math.min(100, Math.round((cronStatus.current / cronStatus.target) * 100))}%</div>
                    <div className="text-xs text-gray-400">{cronStatus.remaining.toLocaleString()} fehlen noch</div>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  {cronStatus.enabled
                    ? `Der Server importiert automatisch bis zu 200 neue Bilder pro Stunde, priorisiert unterrepräsentierte Farben.`
                    : `Alle ${cronStatus.target.toLocaleString()} Bilder erreicht! Der Cron-Job ist pausiert.`}
                </p>
              </div>
            )}

            {/* Gezielte Importe (Empfehlungen) */}
            <div className="bg-white rounded-2xl p-6 border border-amber-200">
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
                      const priorityColor = rec.priority >= 1.5 ? 'border-red-300 bg-red-50' : rec.priority >= 1.0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'
                      const priorityBadge = rec.priority >= 1.5 ? 'bg-red-100 text-red-700' : rec.priority >= 1.0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
                      return (
                        <button
                          key={rec.query}
                          onClick={() => {
                            const next = new Set(selectedRecs)
                            if (isSelected) next.delete(rec.query); else next.add(rec.query)
                            setSelectedRecs(next)
                          }}
                          className={`text-left rounded-xl border-2 p-3 transition-all ${
                            isSelected ? `${priorityColor} ring-2 ring-amber-400` : 'border-gray-200 bg-white opacity-50'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold text-gray-800 truncate">{rec.label}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ml-1 shrink-0 ${priorityBadge}`}>
                              {rec.priority >= 1.5 ? '🔥' : rec.priority >= 1.0 ? '⚡' : '↑'}{rec.priority.toFixed(1)}×
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 truncate">{rec.query}</div>
                          <div className="text-xs text-gray-500 mt-1">Fehlt: {rec.deficit} Bilder</div>
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

              {/* Job progress */}
              {recsJob && (
                <div className="mb-4 bg-gray-50 rounded-xl p-3 text-xs">
                  <div className="font-medium text-gray-700 mb-1">
                    {recsJob.running
                      ? `⏳ Läuft... ${recsJob.imported ?? 0} importiert`
                      : `✅ Fertig: ${recsJob.imported ?? 0} neue Bilder`}
                  </div>
                  <div className="max-h-20 overflow-y-auto space-y-0.5">
                    {recsJob.log.slice(-8).map((l, i) => (
                      <div key={i} className={l.startsWith('✓') ? 'text-green-600' : l.startsWith('✅') ? 'text-green-700 font-medium' : 'text-gray-500'}>{l}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <select
                  value={recsSource}
                  onChange={e => setRecsSource(e.target.value as 'unsplash' | 'pexels')}
                  className="text-sm border border-gray-200 rounded-xl px-3 py-2"
                  disabled={!!activeJob}
                >
                  <option value="pexels" disabled={!apiKeys?.pexels}>Pexels{!apiKeys?.pexels ? ' (kein Key)' : ''}</option>
                  <option value="unsplash" disabled={!apiKeys?.unsplash}>Unsplash{!apiKeys?.unsplash ? ' (kein Key)' : ''}</option>
                  <option value="shutterstock" disabled={!(apiKeys as any)?.shutterstock}>Shutterstock{!(apiKeys as any)?.shutterstock ? ' (kein Key)' : ''}</option>
                </select>
                <button
                  onClick={startRecsImport}
                  disabled={!!activeJob || selectedRecs.size === 0 || (!apiKeys?.pexels && !apiKeys?.unsplash)}
                  className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-xl transition-colors text-sm"
                >
                  {activeJob === 'recs_import' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {activeJob === 'recs_import'
                    ? 'Import läuft...'
                    : selectedRecs.size === recommendations.length
                      ? `⚡ Alle ${selectedRecs.size} gleichzeitig starten`
                      : `⚡ ${selectedRecs.size} Empfehlungen starten`}
                </button>
              </div>
            </div>

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

              {/* Progress bars for running jobs */}
              {(['pexels', 'unsplash', 'shutterstock'] as const).map(src => {
                const job = importProgress[src]
                if (!job?.running && !job?.finishedAt) return null
                return (
                  <div key={src} className="mb-3 bg-gray-50 rounded-xl p-3">
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span className="font-medium capitalize">{src}</span>
                      <span>{job.imported ?? 0} / {job.total ?? '?'} neu importiert</span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${job.running ? 'bg-indigo-400 animate-pulse' : 'bg-green-400'}`}
                        style={{ width: `${job.total ? Math.min(100, Math.round(((job.imported ?? 0) / job.total) * 100)) : 0}%` }}
                      />
                    </div>
                    {job.log && job.log.length > 0 && (
                      <div className="mt-1 max-h-16 overflow-y-auto">
                        {job.log.slice(-3).map((l, i) => (
                          <div key={i} className="text-[10px] text-gray-400 truncate">{l}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Alle gleichzeitig */}
              <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-indigo-50 rounded-xl border border-indigo-200">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-indigo-900 text-sm mb-0.5">Alle Quellen gleichzeitig</div>
                  <div className="text-xs text-indigo-600">Startet Pexels + Unsplash + Shutterstock parallel für maximalen Durchsatz</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="number"
                    value={importAllBatch}
                    onChange={e => setImportAllBatch(Math.max(50, Math.min(2000, Number(e.target.value))))}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2 py-1.5 text-center"
                    min={50} max={2000} step={50}
                    disabled={importAllRunning}
                  />
                  <button
                    onClick={startImportAll}
                    disabled={importAllRunning || (!apiKeys?.pexels && !apiKeys?.unsplash && !(apiKeys as any)?.shutterstock)}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm whitespace-nowrap"
                  >
                    {importAllRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {importAllRunning ? 'Startet...' : '⚡ Alle gleichzeitig'}
                  </button>
                </div>
              </div>

              {/* Individual source cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ImportCard title="Pexels" description="Bis zu 80 Bilder/Keyword, diverse Suche. Empfohlen für große Batches." icon={<Camera className="w-5 h-5 text-green-600" />} color="green" available={!!apiKeys?.pexels} job={importProgress['pexels']} isActive={activeJob === 'pexels'} onImport={(n) => startImport('pexels', n)} defaultBatch={500} maxBatch={2000} />
                <ImportCard title="Unsplash" description="Bis zu 30 Bilder/Keyword, hochwertige Fotos. Ergänzt Pexels gut." icon={<Camera className="w-5 h-5 text-purple-600" />} color="purple" available={!!apiKeys?.unsplash} job={importProgress['unsplash']} isActive={activeJob === 'unsplash'} onImport={(n) => startImport('unsplash', n)} defaultBatch={300} maxBatch={1000} />
                <ImportCard title="Shutterstock" description="Bis zu 50 Bilder/Keyword, professionelle Stockfotos. Ideal für Portraits & Hauttöne." icon={<Camera className="w-5 h-5 text-orange-600" />} color="orange" available={!!(apiKeys as any)?.shutterstock} job={importProgress['shutterstock']} isActive={activeJob === 'shutterstock'} onImport={(n) => startImport('shutterstock', n)} defaultBatch={300} maxBatch={1000} />
              </div>
            </div>

            {/* LAB + Seed */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl p-6 border border-gray-200">
                <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <Database className="w-5 h-5 text-green-600" />
                  LAB-Farben indexieren
                </h3>
                <p className="text-gray-600 text-sm mb-4">
                  Berechnet LAB-Farbwerte für alle nicht-indexierten Bilder. Verbessert die Mosaic-Qualität erheblich.
                  Aktuell <strong>{((stats?.total ?? 0) - (stats?.labIndexed ?? 0)).toLocaleString()}</strong> Bilder ohne Index.
                </p>
                {stats && stats.total > 0 && (
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>Fortschritt</span>
                      <span>{Math.round((stats.labIndexed / stats.total) * 100)}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-green-400 rounded-full transition-all" style={{ width: `${Math.round((stats.labIndexed / stats.total) * 100)}%` }} />
                    </div>
                  </div>
                )}
                <button onClick={handleIndexLab} disabled={!!activeJob || ((stats?.total ?? 0) - (stats?.labIndexed ?? 0)) === 0} className="flex items-center gap-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-xl transition-colors text-sm">
                  {activeJob === 'lab' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                  {activeJob === 'lab' ? 'Indexierung läuft...' : `${((stats?.total ?? 0) - (stats?.labIndexed ?? 0)).toLocaleString()} Bilder indexieren`}
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
            </div>
          </div>
        )}

        {/* ── TAB: Datenbank-Browser ── */}
        {activeTab === 'database' && (
          <DatabaseBrowser onMessage={setMessage} />
        )}

        {/* ── TAB: Algorithmus-Einstellungen ── */}
        {activeTab === 'settings' && (
          <AlgorithmSettings />
        )}
      </div>
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
            : job.error ? <span className="text-red-600">{job.error}</span>
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
  const [quickImportLoading, setQuickImportLoading] = useState<string | null>(null)
  const [quickImportResult, setQuickImportResult] = useState<Record<string, string>>({})
  const LIMIT = 60

  const fetchDbStats = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getDbStats')
      const data = await res.json()
      setDbStats(data.result?.data?.json ?? data.result?.data ?? data)
    } catch { /* ignore */ }
  }, [])

  const fetchImages = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const params: Record<string, string | number> = { page: p, limit: LIMIT }
      if (sourceFilter !== 'alle') params.sourceId = sourceFilter
      if (colorFilter !== 'alle') params.colorFilter = colorFilter
      if (brightnessFilter !== 'alle') params.brightnessFilter = brightnessFilter
      const encoded = encodeURIComponent(JSON.stringify(params))
      const res = await fetch(`/api/trpc/getAdminImages?input=${encoded}`)
      const data = await res.json()
      const parsed = data.result?.data ?? data
      setImages(parsed.images ?? [])
      setTotal(parsed.total ?? 0)
    } catch {
      onMessage({ text: 'Fehler beim Laden der Bilder', type: 'error' })
    } finally { setLoading(false) }
  }, [sourceFilter, colorFilter, brightnessFilter, onMessage])

  const runDedup = useCallback(async () => {
    if (!confirm('Duplikate aus der Datenbank entfernen? Jede source_url wird nur einmal behalten (niedrigste ID). Dieser Vorgang kann nicht rückgängig gemacht werden.')) return
    setDedupLoading(true)
    setDedupResult(null)
    try {
      const res = await fetch('/api/admin/dedup-tiles', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setDedupResult(`✅ ${data.message}`)
        setDedupProgress({ before: data.before?.total ?? 0, deleted: data.deleted ?? 0, after: data.after?.total ?? 0 })
        fetchDbStats()
        fetchImages(1)
      } else {
        setDedupResult(`❌ Fehler: ${data.error}`)
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
      const res = await fetch('/api/admin/add-unique-constraint', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setConstraintResult(`✅ ${data.message}`)
      } else {
        setConstraintResult(`❌ Fehler: ${data.error}`)
      }
    } catch (e) {
      setConstraintResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setConstraintLoading(false)
    }
  }, [])

  const runQuickImport = useCallback(async (query: string, label: string) => {
    setQuickImportLoading(query)
    setQuickImportResult(prev => ({ ...prev, [query]: '⏳ Importiere...' }))
    try {
      const res = await fetch('/api/trpc/targetedImport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  useEffect(() => { setPage(1); fetchImages(1) }, [sourceFilter, colorFilter, brightnessFilter])
  useEffect(() => { fetchImages(page) }, [page])

  const handleDelete = async (id: number) => {
    try {
      await fetch('/api/trpc/deleteImage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
      })
      setImages(prev => prev.filter(img => img.id !== id))
      setTotal(prev => prev - 1)
      setSelectedImage(null)
      fetchDbStats()
    } catch { onMessage({ text: 'Fehler beim Löschen', type: 'error' }) }
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
          <div className="px-5 pb-5 space-y-5 border-t border-gray-100">
            {/* By Source */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 mt-4">Nach Quelle</h3>
              <div className="flex flex-wrap gap-3">
                {Object.entries(dbStats.bySource).map(([src, cnt]) => (
                  <button key={src} onClick={() => setSourceFilter(sourceFilter === src ? 'alle' : src)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${sourceFilter === src ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-gray-50 text-gray-700 border-gray-200 hover:border-indigo-300'}`}>
                    {src === 'picsum' ? '📷' : src === 'unsplash' ? '🌄' : src === 'pexels' ? '📸' : '🖼️'}
                    {src} <span className="font-bold">{cnt.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* By Color */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Nach Farbe (LAB-indexiert)</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(COLOR_LABELS).map(([key, { label, color, emoji }]) => {
                  const cnt = dbStats.byColor[key] ?? 0
                  const pct = dbStats.labIndexed > 0 ? Math.round((cnt / dbStats.labIndexed) * 100) : 0
                  return (
                    <button key={key} onClick={() => setColorFilter(colorFilter === key ? 'alle' : key)}
                      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl border transition-all ${colorFilter === key ? 'ring-2 ring-offset-1' : 'hover:border-gray-300'} ${cnt === 0 ? 'opacity-40' : ''}`}
                      style={{ borderColor: colorFilter === key ? color : undefined }}>
                      <span className="text-lg">{emoji}</span>
                      <span className="text-xs font-medium text-gray-700">{label}</span>
                      <span className="text-xs font-bold" style={{ color }}>{cnt.toLocaleString()}</span>
                      <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                      </div>
                    </button>
                  )
                })}
              </div>
              {/* Missing areas hint */}
              {dbStats.labIndexed > 0 && (() => {
                const missing = Object.entries(COLOR_LABELS)
                  .filter(([key]) => (dbStats.byColor[key] ?? 0) < dbStats.labIndexed * 0.05)
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
              <div className="flex gap-3">
                {[
                  { key: 'dunkel', label: 'Dunkel', color: '#374151', bg: 'bg-gray-800' },
                  { key: 'mittel', label: 'Mittel', color: '#6b7280', bg: 'bg-gray-400' },
                  { key: 'hell',   label: 'Hell',   color: '#d1d5db', bg: 'bg-gray-200' },
                ].map(({ key, label, color, bg }) => {
                  const cnt = dbStats.byBrightness[key] ?? 0
                  const pct = dbStats.labIndexed > 0 ? Math.round((cnt / dbStats.labIndexed) * 100) : 0
                  return (
                    <button key={key} onClick={() => setBrightnessFilter(brightnessFilter === key ? 'alle' : key)}
                      className={`flex-1 flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${brightnessFilter === key ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
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
                  <div className="flex gap-2 mb-2">
                    <div className="flex-1 bg-orange-50 border border-orange-200 rounded-xl p-3 text-center">
                      <div className="text-2xl mb-1">🔥</div>
                      <div className="text-xs text-gray-500">Warm</div>
                      <div className="text-lg font-bold text-orange-600">{warmPct}%</div>
                      <div className="text-xs text-gray-400">{warm.toLocaleString()}</div>
                    </div>
                    <div className="flex-1 bg-gray-50 border border-gray-200 rounded-xl p-3 text-center">
                      <div className="text-2xl mb-1">⚪</div>
                      <div className="text-xs text-gray-500">Neutral</div>
                      <div className="text-lg font-bold text-gray-600">{neutralPct}%</div>
                      <div className="text-xs text-gray-400">{neutral.toLocaleString()}</div>
                    </div>
                    <div className={`flex-1 rounded-xl p-3 text-center border ${kuehlOk ? 'bg-blue-50 border-blue-200' : 'bg-red-50 border-red-200'}`}>
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
                  <div className="flex gap-1 h-16 items-end mb-2">
                    {levels.map(({ key, label, color, target }) => {
                      const cnt = dbStats.byBrightness5![key] ?? 0
                      const pct = Math.round(cnt / total5 * 100)
                      const ok = pct >= target * 0.7
                      return (
                        <div key={key} className="flex-1 flex flex-col items-center gap-1">
                          <div className="text-xs font-bold" style={{ color: ok ? '#16a34a' : '#dc2626' }}>{pct}%</div>
                          <div className="w-full rounded-t-sm transition-all" style={{ height: `${Math.max(4, pct * 2)}px`, backgroundColor: color, border: '1px solid #e5e7eb' }} />
                          <div className="text-xs text-gray-400 text-center leading-tight" style={{ fontSize: '10px' }}>{label.replace(' ', '\n')}</div>
                        </div>
                      )
                    })}
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
                  <div className="flex gap-2 mb-2">
                    {[
                      { label: 'Niedrig (glatt)', pct: lowPct, cnt: low, color: 'bg-emerald-100 border-emerald-300', text: 'text-emerald-700', icon: '🌫️', tip: 'Ideal für Hauttöne & Hintergründe', target: 30 },
                      { label: 'Mittel', pct: midPct, cnt: mid, color: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700', icon: '🎨', tip: 'Gute Allround-Tiles', target: 40 },
                      { label: 'Hoch (bunt)', pct: highPct, cnt: high, color: 'bg-pink-50 border-pink-200', text: 'text-pink-700', icon: '🌈', tip: 'Zu viele → Haut wirkt unruhig', target: 30 },
                    ].map(({ label, pct, cnt, color, text, icon, tip }) => (
                      <div key={label} className={`flex-1 rounded-xl p-3 border ${color}`}>
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
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
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
              // Score: 0-100
              let score = 0
              score += Math.min(kuehlPct / 20 * 25, 25)       // kühl: max 25 pts bei ≥20%
              score += Math.min(extremeDark / 10 * 15, 15)    // extrem dunkel: max 15 pts
              score += Math.min(extremeLight / 10 * 15, 15)   // extrem hell: max 15 pts
              score += Math.min(lowSat / 30 * 25, 25)         // niedrig sättigung: max 25 pts
              score += Math.min(grayPct / 15 * 20, 20)        // grau: max 20 pts
              const scoreInt = Math.round(score)
              const scoreColor = scoreInt >= 75 ? 'text-green-600' : scoreInt >= 50 ? 'text-yellow-600' : 'text-red-600'
              const scoreBg = scoreInt >= 75 ? 'bg-green-50 border-green-200' : scoreInt >= 50 ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'
              const scoreLabel = scoreInt >= 75 ? 'Gut – Pool eignet sich gut für Portraits' : scoreInt >= 50 ? 'Mittel – Verbesserungen empfohlen' : 'Schwach – Pool für Portraits nicht optimal'
              return (
                <div className={`rounded-xl border p-4 ${scoreBg}`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-700">🎭 Portrait-Qualitäts-Score</h3>
                    <span className={`text-2xl font-bold ${scoreColor}`}>{scoreInt}/100</span>
                  </div>
                  <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden mb-2">
                    <div className={`h-full rounded-full transition-all ${scoreInt >= 75 ? 'bg-green-500' : scoreInt >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${scoreInt}%` }} />
                  </div>
                  <p className={`text-xs ${scoreColor} font-medium`}>{scoreLabel}</p>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-gray-500">
                    <span>❄️ Kühl: {kuehlPct}% / 20% Ziel</span>
                    <span>⚫ Extrem Dunkel: {extremeDark}% / 10% Ziel</span>
                    <span>⚪ Extrem Hell: {extremeLight}% / 10% Ziel</span>
                    <span>🌫️ Niedrig-Sättigung: {lowSat}% / 30% Ziel</span>
                  </div>
                </div>
              )
            })()}

          </div>
        )}
      </div>

      {/* Dedup Button */}
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
        </div>
        <div className="flex flex-col gap-2">
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
        {(sourceFilter !== 'alle' || colorFilter !== 'alle' || brightnessFilter !== 'alle') && (
          <button onClick={() => { setSourceFilter('alle'); setColorFilter('alle'); setBrightnessFilter('alle') }}
            className="text-xs text-red-500 hover:text-red-700 ml-auto">Alle Filter zurücksetzen</button>
        )}
        <span className="ml-auto text-sm text-gray-500">{total.toLocaleString()} Bilder gefunden</span>
      </div>

      {/* Image Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
        </div>
      ) : images.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Image className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>Keine Bilder gefunden</p>
        </div>
      ) : (
        <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-1.5">
          {images.map(img => (
            <button key={img.id} onClick={() => setSelectedImage(img)}
              className="relative group aspect-square rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 hover:scale-105 transition-all">
              <img
                src={getHighResUrl(img.tile128Url || img.sourceUrl, 300)}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%23e5e7eb" width="64" height="64"/></svg>' }}
              />
              {/* Color dot */}
              {img.colorCategory && COLOR_LABELS[img.colorCategory] && (
                <div className="absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full border border-white"
                  style={{ backgroundColor: COLOR_LABELS[img.colorCategory].color }} />
              )}
            </button>
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
              src={getHighResUrl(selectedImage.sourceUrl, 600)}
              alt=""
              className="w-full aspect-square object-cover rounded-xl mb-4"
              onError={(e) => { (e.target as HTMLImageElement).src = selectedImage.sourceUrl }}
            />
            <div className="space-y-2 text-sm text-gray-600">
              <div className="flex justify-between"><span>Quelle:</span><span className="font-medium">{selectedImage.sourceId}</span></div>
              <div className="flex justify-between"><span>Farbe:</span>
                <span className="font-medium flex items-center gap-1">
                  {selectedImage.colorCategory ? (
                    <><span>{COLOR_LABELS[selectedImage.colorCategory]?.emoji}</span> {COLOR_LABELS[selectedImage.colorCategory]?.label ?? selectedImage.colorCategory}</>
                  ) : 'Nicht indexiert'}
                </span>
              </div>
              <div className="flex justify-between"><span>Helligkeit:</span><span className="font-medium">{selectedImage.brightnessCategory ?? 'Nicht indexiert'}</span></div>
              <div className="flex justify-between"><span>LAB:</span><span className="font-mono text-xs">{selectedImage.avgL.toFixed(1)}, {selectedImage.avgA.toFixed(1)}, {selectedImage.avgB.toFixed(1)}</span></div>
              <div className="flex justify-between"><span>Thema:</span><span className="font-medium">{selectedImage.subject ?? 'general'}</span></div>
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
function AlgorithmSettings() {
  const [settings, setSettings] = useState<AlgoSettings>(loadSettings)
  const [saved, setSaved] = useState(false)

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
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100">
          <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-1">
            <Settings className="w-5 h-5 text-indigo-500" />
            Algorithmus-Parameter
          </h2>
          <p className="text-sm text-gray-500">Diese Werte steuern den Mosaic-Algorithmus im Studio. Änderungen werden sofort beim nächsten Mosaik-Rendering angewendet.</p>
        </div>

        <div className="p-6 space-y-1">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Kachel-Raster</h3>
          <SliderRow label="Anzahl Kacheln (Basis)" desc="Kacheln entlang der längsten Seite. Weniger = grösser = besser erkennbar." settingKey="baseTiles" min={20} max={100} />
          <SliderRow label="Kachel-Grösse (px)" desc="Pixel pro Kachel im Vorschau-Canvas. Grösser = schärfer, aber langsamer." settingKey="tilePx" min={16} max={64} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Farb-Overlay</h3>
          <SliderRow label="Basis-Overlay" desc="Grundstärke des Farb-Overlays. Höher = Gesamtbild besser erkennbar." settingKey="baseOverlay" min={0} max={0.5} step={0.01} format={v => (v * 100).toFixed(0) + '%'} />
          <SliderRow label="Kanten-Boost" desc="Zusätzlicher Overlay an Kanten/Konturen. Höher = schärfere Konturen." settingKey="edgeBoost" min={0} max={0.5} step={0.01} format={v => (v * 100).toFixed(0) + '%'} />

          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 mt-6">Anti-Repetition</h3>
          <SliderRow label="Nachbar-Radius" desc="Wie viele Kacheln um eine Kachel herum auf Wiederholung geprüft werden." settingKey="neighborRadius" min={1} max={8} />
          <SliderRow label="Nachbar-Penalty" desc="Stärke der Bestrafung für wiederholte Kacheln in der Nähe. Höher = mehr Vielfalt." settingKey="neighborPenalty" min={0} max={500} step={10} />

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
    </div>
  )
}
