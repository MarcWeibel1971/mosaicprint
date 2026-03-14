import { useState, useEffect, useCallback, useRef } from 'react'
// jsPDF loaded dynamically to avoid chunk initialization errors at module load time
import {
  Database, RefreshCw, Upload, Image, Save, CheckCircle, XCircle,
  Zap, Camera, Settings, Grid, BarChart2, Filter, ChevronLeft, ChevronRight, Trash2, X, Download, FileText, AlertTriangle
} from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Upgrade a tile URL to a higher-resolution preview URL */
function getHighResUrl(url: string, size = 600, tile128Url?: string): string {
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
  return url
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface DbStats { total: number; labIndexed: number; notIndexed: number }
interface ApiKeyStatus { stripe: boolean; unsplash: boolean; pexels: boolean; pixabay: boolean }
interface ImportJob {
  running: boolean; imported?: number; total?: number
  log: string[]; error?: string | null; finishedAt?: string | null
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
  semanticTheme: string | null
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
      neighborRadius: 5, neighborPenalty: 240,
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  // Also save as overrides so Studio preset-merge respects manual Admin changes
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

// ── Main Component ──────────────────────────────────────────────────────────────
export default function Admin() {
  // Mark admin as visited in localStorage so Studio shows admin-only buttons
  useEffect(() => {
    try { localStorage.setItem('mosaicprint_admin_visited', '1'); } catch {}
  }, []);
  const [activeTab, setActiveTab] = useState<'database' | 'import' | 'algorithm' | 'quality'>('database')
  const [stats, setStats] = useState<DbStats | null>(null)
  const [apiKeys, setApiKeys] = useState<ApiKeyStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [activeJob, setActiveJob] = useState<string | null>(null)
  const [activeJobs, setActiveJobs] = useState<Set<string>>(new Set())
  const [importProgress, setImportProgress] = useState<Record<string, ImportJob>>({})
  const [cronStatus, setCronStatus] = useState<CronStatus | null>(null)
  const [smartJob, setSmartJob] = useState<SmartImportJob | null>(null)
  const [smartSource, setSmartSource] = useState<'unsplash' | 'pexels' | 'pixabay'>('pexels')
  const [importAllBatch, setImportAllBatch] = useState(500)
  const [importAllRunning, setImportAllRunning] = useState(false)
  const [importCategory, setImportCategory] = useState<string>('')  // selected category for targeted import
  // Gezielte Importe (Empfehlungen)
  interface ImportRecommendation { query: string; label: string; priority: number; deficit: number; subject: string }
  const [recommendations, setRecommendations] = useState<ImportRecommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [recsJobs, setRecsJobs] = useState<Record<string, SmartImportJob>>({})
  const [recsRunning, setRecsRunning] = useState(false)
  const [selectedRecs, setSelectedRecs] = useState<Set<string>>(new Set())
  const [recsExpanded, setRecsExpanded] = useState(false)

  const fetchCronStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getCronStatus')
      const data = await res.json()
      setCronStatus(data.result?.data?.json ?? data.result?.data ?? data)
    } catch { /* ignore */ }
  }, [])

  const startSmartImport = async (sourceId: 'unsplash' | 'pexels' | 'pixabay') => {
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
      // Select only Top 5 by deficit (largest gap first) by default
      const top5 = [...(result.tasks ?? [])]
        .sort((a: { deficit: number }, b: { deficit: number }) => b.deficit - a.deficit)
        .slice(0, 5)
        .map((t: { query: string }) => t.query);
      setSelectedRecs(new Set(top5))
    } catch { /* ignore */ } finally {
      setRecsLoading(false)
    }
  }, [])

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: src, count: queriesToRun.length * 400, targetPerBucket: 500 }),
      }).catch(() => {
        setRecsJobs(prev => ({ ...prev, [src]: { ...prev[src], running: false, error: 'Fehler beim Starten' } }))
      })
    ))
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
    if (activeJob.startsWith('smart_')) return  // smart_ jobs use separate polling
    const interval = setInterval(async () => {
      try {
        const params = encodeURIComponent(JSON.stringify({ sourceId: activeJob }))
        const res = await fetch(`/api/trpc/getImportStatus?input=${params}`)
        const data = await res.json()
        const raw = data.result?.data ?? data
        const job: ImportJob = { log: [], ...raw }
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

  // Poll multiple import jobs simultaneously (used by importAll)
  useEffect(() => {
    if (activeJobs.size === 0) return
    const intervals: ReturnType<typeof setInterval>[] = []
    activeJobs.forEach(src => {
      const interval = setInterval(async () => {
        try {
          const params = encodeURIComponent(JSON.stringify({ sourceId: src }))
          const res = await fetch(`/api/trpc/getImportStatus?input=${params}`)
          const data = await res.json()
          const raw = data.result?.data ?? data
          const job: ImportJob = { log: [], ...raw }
          setImportProgress(prev => ({ ...prev, [src]: job }))
          if (!job.running && job.finishedAt) {
            setActiveJobs(prev => { const next = new Set(prev); next.delete(src); return next })
            fetchStats()
            if (job.error) setMessage({ text: `Fehler (${src}): ${job.error}`, type: 'error' })
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
        const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`)
        const data = await res.json()
        const raw2 = data.result?.data ?? data
        const job: SmartImportJob = { log: [], ...raw2 }
        setSmartJob(job)
        if (!job.running && job.finishedAt) {
          setActiveJob(null)
          fetchStats()
          fetchCronStatus()
          fetchRecommendations()
          if (job.error) setMessage({ text: `Fehler: ${job.error}`, type: 'error' })
          else setMessage({ text: `Import abgeschlossen: ${job.imported ?? 0} neue Bilder importiert`, type: 'success' })
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(interval)
  }, [activeJob, fetchStats, fetchCronStatus, fetchRecommendations])

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
          const res = await fetch(`/api/trpc/getSmartImportStatus?input=${params}`)
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
                fetchCronStatus()
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
  }, [recsRunning, recsJobs, fetchStats, fetchCronStatus, fetchRecommendations])

  const startImport = async (sourceId: string, batchSize: number) => {
    if (activeJob) return
    setActiveJob(sourceId)
    setMessage({ text: `Import von ${sourceId} gestartet (${batchSize} Bilder, diverse Keywords)...`, type: 'info' })
    setImportProgress(prev => ({ ...prev, [sourceId]: { running: true, log: [], imported: 0, total: batchSize } }))
    try {
      await fetch('/api/trpc/importFromSource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
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
              { id: 'database', label: 'Datenbank', icon: Grid },
              { id: 'import', label: 'Import', icon: Upload },
              { id: 'algorithm', label: 'Algorithmus', icon: Settings },
              { id: 'quality', label: 'Qualität & Statistik', icon: BarChart2 },
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
              {(['pexels', 'unsplash', 'pixabay'] as const).map(src => {
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

              {/* Kategorie-Auswahl für gezielten Import */}
              <div className="mb-4 p-4 bg-amber-50 rounded-xl border border-amber-200">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-semibold text-amber-900">🎯 Kategorie-Import (optional)</span>
                  <span className="text-xs text-amber-600">Wähle eine Bildkategorie um gezielt Keywords für diese Kategorie zu importieren</span>
                </div>
                <select
                  value={importCategory}
                  onChange={e => setImportCategory(e.target.value)}
                  className="w-full text-sm border border-amber-300 rounded-lg px-3 py-2 bg-white text-gray-800"
                >
                  <option value="">— Kein Kategorie-Filter (Standard: Gap-basiert) —</option>
                  <optgroup label="Portraits">
                    <option value="portrait_light_skin">👤 Portrait – Helle Haut / Blond</option>
                    <option value="portrait_medium_skin">👤 Portrait – Mittlere Haut / Braun</option>
                    <option value="portrait_dark_skin">👤 Portrait – Dunkle Haut</option>
                    <option value="portrait_olive_skin">👤 Portrait – Olive / Dunkles Haar</option>
                    <option value="portrait_glasses">👓 Portrait – Brille / Graues Haar</option>
                    <option value="portrait_red_hair">🦰 Portrait – Rotes Haar</option>
                    <option value="portrait_child">👶 Portrait – Kind / Baby</option>
                    <option value="portrait_elderly">👴 Portrait – Ältere Person</option>
                    <option value="portrait_backlight">🌅 Portrait – Gegenlicht / Silhouette</option>
                    <option value="portrait_group">👥 Portrait – Gruppe / Mehrere Personen</option>
                  </optgroup>
                  <optgroup label="Natur">
                    <option value="nature_sunset">🌅 Natur – Sonnenuntergang</option>
                    <option value="nature_ocean">🌊 Natur – Ozean / Meer</option>
                    <option value="nature_forest">🌲 Natur – Wald / Grün</option>
                    <option value="nature_snow">❄️ Natur – Schnee / Winter</option>
                    <option value="nature_mountains">⛰️ Natur – Berge</option>
                  </optgroup>
                  <optgroup label="Stadt">
                    <option value="city_night">🌃 Stadt – Skyline Nacht</option>
                    <option value="city_architecture">🏛️ Stadt – Architektur</option>
                  </optgroup>
                  <optgroup label="Tiere">
                    <option value="animal_warm">🦁 Tiere – Erdtöne (Löwe etc.)</option>
                    <option value="animal_colorful">🦜 Tiere – Bunt (Vögel etc.)</option>
                  </optgroup>
                </select>
                {importCategory && (
                  <p className="mt-1 text-xs text-amber-700">✅ Import wird mit Kategorie-Keywords für <strong>{importCategory}</strong> priorisiert</p>
                )}
              </div>

              {/* Alle gleichzeitig */}
              <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-indigo-50 rounded-xl border border-indigo-200">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-indigo-900 text-sm mb-0.5">Alle Quellen gleichzeitig</div>
                  <div className="text-xs text-indigo-600">Startet Pexels + Unsplash + Pixabay parallel für maximalen Durchsatz</div>
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
                    disabled={importAllRunning || (!apiKeys?.pexels && !apiKeys?.unsplash && !apiKeys?.pixabay)}
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
                <ImportCard title="Pixabay" description="Bis zu 200 Bilder/Keyword, lizenzfreie CC0-Fotos ohne Wasserzeichen. Ideal für Portraits & Hauttöne." icon={<Camera className="w-5 h-5 text-orange-600" />} color="orange" available={!!apiKeys?.pixabay} job={importProgress['pixabay']} isActive={activeJob === 'pixabay'} onImport={(n) => startImport('pixabay', n)} defaultBatch={300} maxBatch={1000} />
              </div>
            </div>

            {/* LAB + Seed */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
  const [shutterstockLoading, setShutterstockLoading] = useState(false)
  const [shutterstockResult, setShutterstockResult] = useState<string | null>(null)
  const [quickImportLoading, setQuickImportLoading] = useState<string | null>(null)
  const [quickImportResult, setQuickImportResult] = useState<Record<string, string>>({})
  const [pdfExporting, setPdfExporting] = useState(false)
  const [importedSince, setImportedSince] = useState('alle')
  const [qualityStatusFilter, setQualityStatusFilter] = useState('alle')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [sourceDeleting, setSourceDeleting] = useState(false)
  const [semanticThemeFilter, setSemanticThemeFilter] = useState('alle')
  const [batchTagging, setBatchTagging] = useState(false)
  const [batchTagResult, setBatchTagResult] = useState<string | null>(null)
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
      if (importedSince !== 'alle') params.importedSince = importedSince
      if (qualityStatusFilter !== 'alle') params.qualityStatus = qualityStatusFilter
      if (semanticThemeFilter !== 'alle') params.semanticTheme = semanticThemeFilter
      const encoded = encodeURIComponent(JSON.stringify(params))
      const res = await fetch(`/api/trpc/getAdminImagesFiltered?input=${encoded}`)
      const data = await res.json()
      const parsed = data.result?.data ?? data
      setImages(parsed.images ?? [])
      setTotal(parsed.total ?? 0)
    } catch {
      onMessage({ text: 'Fehler beim Laden der Bilder', type: 'error' })
    } finally { setLoading(false) }
  }, [sourceFilter, colorFilter, brightnessFilter, importedSince, qualityStatusFilter, semanticThemeFilter, onMessage])

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

  const runRemoveShutterstock = useCallback(async () => {
    if (!confirm('Alle Shutterstock-Bilder (mit Wasserzeichen) aus der Datenbank entfernen? Dieser Vorgang kann nicht rükgängig gemacht werden.')) return
    setShutterstockLoading(true)
    setShutterstockResult(null)
    try {
      const res = await fetch('/api/admin/remove-shutterstock', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setShutterstockResult(`✅ ${data.message}`)
        fetchDbStats()
        fetchImages(1)
      } else {
        setShutterstockResult(`❌ Fehler: ${data.error}`)
      }
    } catch (e) {
      setShutterstockResult(`❌ Netzwerkfehler: ${String(e)}`)
    } finally {
      setShutterstockLoading(false)
    }
  }, [fetchDbStats, fetchImages])

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
  useEffect(() => { setPage(1); fetchImages(1) }, [sourceFilter, colorFilter, brightnessFilter, semanticThemeFilter])
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
      const res = await fetch(`/api/trpc/getAllTilesForPdf?input=${encoded}`)
      const data = await res.json()
      const parsed = data.result?.data ?? data
      const allImages: TileImage[] = parsed.images ?? []

      if (allImages.length === 0) {
        onMessage({ text: 'Keine Tiles gefunden für den Export', type: 'error' })
        return
      }

      // Pre-load all images in parallel batches of 30
      const BATCH = 30
      const b64Map = new Map<number, string>()
      for (let i = 0; i < allImages.length; i += BATCH) {
        const batch = allImages.slice(i, i + BATCH)
        const pct = Math.round((i / allImages.length) * 80)
        onMessage({ text: `PDF: Lade Bilder... ${pct}% (${i}/${allImages.length})`, type: 'info' })
        await Promise.all(batch.map(async (img) => {
          try {
            const imgRes = await fetch(`/api/tile/${img.id}?size=64`)
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
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
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
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

  const runBatchTag = async () => {
    if (!confirm('Alle Tiles ohne Semantic-Tag automatisch taggen? (Kann einige Minuten dauern)')) return
    setBatchTagging(true)
    setBatchTagResult(null)
    try {
      const res = await fetch('/api/trpc/batchTagSemanticThemes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      })
      const data = await res.json()
      const result = data.result?.data?.json ?? data.result?.data ?? data
      setBatchTagResult(`✅ ${result.tagged ?? 0} Tiles getaggt`)
      fetchImages(page)
      fetchDbStats()
    } catch (e) {
      setBatchTagResult(`❌ Fehler: ${String(e)}`)
    } finally {
      setBatchTagging(false)
    }
  }

  const handleDeleteBySource = async (source: string) => {
    const count = dbStats.bySource?.[source] ?? 0
    if (!confirm(`Alle ${count.toLocaleString()} ${source}-Tiles unwiderruflich löschen?\n\nDieser Vorgang kann nicht rückgängig gemacht werden!`)) return
    setSourceDeleting(true)
    try {
      const res = await fetch('/api/trpc/deleteBySource', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
          <div className="px-5 pb-5 space-y-5 border-t border-gray-100">
            {/* By Source */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3 mt-4">Nach Quelle</h3>
              <div className="flex flex-wrap gap-3">
                {Object.entries(dbStats.bySource).map(([src, cnt]) => (
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
          <button
            onClick={runBatchTag}
            disabled={batchTagging}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            {batchTagging ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>🏷️</span>}
            {batchTagging ? 'Tagge Tiles...' : 'Semantic-Tags vergeben'}
          </button>
          {batchTagResult && <p className="text-xs font-medium text-indigo-700">{batchTagResult}</p>}
        </div>
      </div>

      {/* Import & Quality Filter Bar */}
      <div className="bg-white rounded-2xl p-4 border border-gray-200 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Import-Zeitraum:</span>
          {['alle', '24h', '7d', '30d'].map(v => (
            <button key={v} onClick={() => { setImportedSince(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                importedSince === v ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {v === 'alle' ? 'Alle' : v === '24h' ? 'Letzte 24h' : v === '7d' ? 'Letzte 7 Tage' : 'Letzte 30 Tage'}
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
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Semantic-Tag:</span>
          {['alle', 'portrait', 'nature_ocean', 'nature_forest', 'nature_sunset', 'nature_snow', 'city_night', 'abstract_colorful', 'general'].map(v => (
            <button key={v} onClick={() => { setSemanticThemeFilter(v); setPage(1) }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                semanticThemeFilter === v ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {v === 'alle' ? 'Alle' : v === 'portrait' ? '👤 Portrait' : v === 'nature_ocean' ? '🌊 Ozean' : v === 'nature_forest' ? '🌿 Wald' : v === 'nature_sunset' ? '🌅 Sonnenuntergang' : v === 'nature_snow' ? '❄️ Schnee' : v === 'city_night' ? '🌃 Nacht' : v === 'abstract_colorful' ? '🎨 Bunt' : '📦 Allgemein'}
            </button>
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
            Import: {importedSince === '24h' ? 'Letzte 24h' : importedSince === '7d' ? 'Letzte 7 Tage' : 'Letzter Import'}
            <button onClick={() => setImportedSince('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {qualityStatusFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-amber-100 text-amber-700 text-xs px-2 py-1 rounded-full">
            Qualität: {qualityStatusFilter}
            <button onClick={() => setQualityStatusFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {semanticThemeFilter !== 'alle' && (
          <span className="flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2 py-1 rounded-full">
            🏷️ {semanticThemeFilter}
            <button onClick={() => setSemanticThemeFilter('alle')}><X className="w-3 h-3" /></button>
          </span>
        )}
        {(sourceFilter !== 'alle' || colorFilter !== 'alle' || brightnessFilter !== 'alle' || importedSince !== 'alle' || qualityStatusFilter !== 'alle' || semanticThemeFilter !== 'alle') && (
          <button onClick={() => { setSourceFilter('alle'); setColorFilter('alle'); setBrightnessFilter('alle'); setImportedSince('alle'); setQualityStatusFilter('alle'); setSemanticThemeFilter('alle') }}
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
          <Image className="w-12 h-12 mx-auto mb-3 opacity-30" />
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
              src={getHighResUrl(selectedImage.sourceUrl, 600, selectedImage.tile128Url)}
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
              <div className="flex justify-between"><span>Farbe:</span>
                <span className="font-medium flex items-center gap-1">
                  {selectedImage.colorCategory ? (
                    <><span>{COLOR_LABELS[selectedImage.colorCategory]?.emoji}</span> {COLOR_LABELS[selectedImage.colorCategory]?.label ?? selectedImage.colorCategory}</>
                  ) : 'Nicht indexiert'}
                </span>
              </div>
              <div className="flex justify-between"><span>Helligkeit:</span><span className="font-medium">{selectedImage.brightnessCategory ?? 'Nicht indexiert'}</span></div>
              <div className="flex justify-between"><span>Thema:</span><span className="font-medium">{selectedImage.subject ?? 'general'}</span></div>
              <div className="flex justify-between"><span>Semantic-Tag:</span>
                <span className="font-medium text-indigo-600">{selectedImage.semanticTheme ?? <span className="text-gray-400 italic">nicht getaggt</span>}</span>
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
      const res = await fetch('/api/trpc/getImageCategories')
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-4">Anti-Repetition</p>
          {numField('neighborRadius', 'Radius', 1, 20, 1)}
          {numField('neighborPenalty', 'Penalty', 0, 500, 10)}
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
          <SliderRow label="Nachbar-Radius" desc="Wie viele Kacheln um eine Kachel herum auf Wiederholung geprüft werden." settingKey="neighborRadius" min={1} max={8} />
          <SliderRow label="Nachbar-Penalty" desc="Stärke der Bestrafung für wiederholte Kacheln in der Nähe. Höher = mehr Vielfalt." settingKey="neighborPenalty" min={0} max={500} step={10} />
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
              {grid.antiRepeat && <div className="mt-2 text-xs text-gray-500">Anti-Repetitions-Radius: {(grid.antiRepeat as Record<string,unknown>).radius as number} Kacheln · Penalty {(grid.antiRepeat as Record<string,unknown>).penalty as number}</div>}
              {grid.faceDetection && <div className="mt-1 text-xs text-gray-500">Gesichtserkennung: {(grid.faceDetection as Record<string,unknown>).count as number} Gesicht · {(grid.faceDetection as Record<string,unknown>).pct as number}% Kacheln</div>}
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

function QualityAssurance({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const [runs, setRuns] = useState<QaRun[]>([])
  const [runningChecks, setRunningChecks] = useState<Set<string>>(new Set())
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [runItems, setRunItems] = useState<QaItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(Date.now())

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getQualityRuns?input=' + encodeURIComponent(JSON.stringify({ limit: 50 })))
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
  }, [])

  useEffect(() => { fetchRuns() }, [fetchRuns, lastRefresh])

  const fetchItems = useCallback(async (runId: number) => {
    setLoadingItems(true)
    try {
      const res = await fetch('/api/trpc/getQualityRunItems?input=' + encodeURIComponent(JSON.stringify({ runId })))
      const data = await res.json()
      setRunItems(data.result?.data?.json ?? data.result?.data ?? [])
    } catch { /* ignore */ }
    finally { setLoadingItems(false) }
  }, [])

  useEffect(() => {
    if (selectedRun !== null) fetchItems(selectedRun)
  }, [selectedRun, fetchItems])

  const runCheck = useCallback(async (checkType: string) => {
    setRunningChecks(prev => new Set([...prev, checkType]))
    try {
      const res = await fetch('/api/trpc/runQualityCheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch('/api/trpc/getAutoLearnRuns')
      const data = await res.json()
      const rows = data.result?.data?.json ?? data.result?.data ?? []
      if (Array.isArray(rows)) setAutoLearnRuns(rows)
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { fetchAutoLearnRuns() }, [fetchAutoLearnRuns])
  const startAutoLearn = useCallback(async () => {
    setAutoLearnRunning(true)
    setAutoLearnSteps([])
    try {
      const res = await fetch('/api/trpc/startAutoLearnCycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importCount: autoLearnImportCount, targetPerBucket: autoLearnTargetPerBucket }),
      })
      const data = await res.json()
      const runId: number = data.result?.data?.json?.runId ?? data.result?.data?.runId
      if (!runId) throw new Error('Kein runId erhalten')
      onMessage({ text: `Auto-Learn-Zyklus gestartet (Run #${runId})`, type: 'info' })
      // Poll status
      const poll = setInterval(async () => {
        try {
          const r2 = await fetch('/api/trpc/getAutoLearnRun?input=' + encodeURIComponent(JSON.stringify({ runId })))
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

  // Load categories from DB
  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getImageCategories')
      const data = await res.json()
      const result = data.result?.data?.json ?? data.result?.data ?? data
      if (Array.isArray(result)) setCategories(result)
    } catch { /* ignore */ }
  }, [])
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
        headers: { 'Content-Type': 'application/json' },
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
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
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

        const toLinear = (v: number) => { const c = v/255; return c > 0.04045 ? Math.pow((c+0.055)/1.055, 2.4) : c/12.92 }
        const rgbToLab = (r: number, g: number, b: number) => {
          const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b)
          const x = (rl*0.4124 + gl*0.3576 + bl*0.1805)/0.95047
          const y = (rl*0.2126 + gl*0.7152 + bl*0.0722)/1.00000
          const z = (rl*0.0193 + gl*0.1192 + bl*0.9505)/1.08883
          const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787*t + 16/116
          return { L: 116*f(y) - 16, a: 500*(f(x)-f(y)), b: 200*(f(y)-f(z)) }
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
        const skinPixels = allLab.filter(p => p.a > 3 && p.b > 5 && p.L > 30 && p.L < 85 && Math.sqrt(p.a*p.a+p.b*p.b) < 45).length
        const facesDetected = skinPixels / totalPx > 0.12

        // Sky: top 25% of image, bright + blue/neutral
        const topQuarter = allLab.slice(0, Math.floor(totalPx * 0.25))
        const skyPixels = topQuarter.filter(p => p.L > 55 && p.a > -15 && p.a < 5 && p.b < 5).length
        const skyDetected = skyPixels / topQuarter.length > 0.3

        // Water: mid region, blue/teal
        const midRegion = allLab.slice(Math.floor(totalPx * 0.25), Math.floor(totalPx * 0.75))
        const waterPixels = midRegion.filter(p => p.a < -2 && p.b < 0 && p.L > 25 && p.L < 75).length
        const waterDetected = waterPixels / midRegion.length > 0.2

        // ── 8. Scene type ──
        let sceneType = 'unknown'
        if (facesDetected && skinPixels / totalPx > 0.2) sceneType = 'portrait'
        else if (skyDetected && waterDetected) sceneType = 'seascape'
        else if (skyDetected && avgA < -5) sceneType = 'landscape'
        else if (avgL < 35 && avgChroma < 20) sceneType = 'cityscape_night'
        else if (edgeDensity > 0.35 && !facesDetected) sceneType = 'architecture'
        else if (avgA < -10 && avgB > 5) sceneType = 'nature_green'
        else if (avgA > 8 && avgB > 10 && avgL > 40) sceneType = 'nature_warm'
        else if (avgL > 72 && avgChroma < 12) sceneType = 'nature_snow'
        else if (avgChroma > 45) sceneType = 'abstract_colorful'
        else if (facesDetected) sceneType = 'portrait'

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
      // Compute LAB zones + Feature Vector client-side via Canvas
      let labZones: Array<{L: number; a: number; b: number; count: number}> = []
      let featureVector: ReturnType<typeof computeLabZonesFromImage> extends Promise<infer T> ? T['featureVector'] : never
      let imageError = ''
      const imageSrc = testImageFile ? testImageFile.base64 : testImageUrl.trim()
      try {
        const result = await computeLabZonesFromImage(imageSrc)
        labZones = result.labZones
        featureVector = result.featureVector
        if (labZones.length === 0) imageError = 'Canvas konnte Bild nicht lesen (CORS?)'
      } catch (e) {
        const err = e as Error
        imageError = `${err?.name ?? 'Error'}: ${err?.message ?? String(e)} | stack: ${err?.stack?.split('\n').slice(0,3).join(' | ') ?? 'n/a'}`
        console.error('[Admin] computeLabZonesFromImage failed:', e)
        featureVector = { sceneType: 'unknown', textureLevel: 'medium', edgeDensity: 0, brightnessRange: 'medium', avgL: 50, avgChroma: 0, dominantColors: [], facesDetected: false, skyDetected: false, waterDetected: false, tileType: 'medium' }
      }
      const body = {
        imageUrl: testImageFile ? undefined : testImageUrl.trim(),
        labZones,
        imageError: imageError || undefined,
      }
      const res = await fetch('/api/trpc/analyzeTestImage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      const serverResult = data.result?.data?.json ?? data.result?.data
      // Merge feature vector into result
      setTestAnalysis({ ...serverResult, featureVector, imageError: imageError || serverResult?.imageError })
      // Auto-detect category from feature vector
      if (labZones.length > 0) {
        setDetectedCategory(featureVector.sceneType !== 'unknown' ? featureVector.sceneType : detectCategory(labZones))
      }
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
          <button onClick={fetchRuns} className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-4 py-2 rounded-xl text-sm transition-colors">
            <RefreshCw className="w-4 h-4" />
            Aktualisieren
          </button>
          <button onClick={runAll} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2 rounded-xl text-sm transition-colors">
            <Zap className="w-4 h-4" />
            Alle Checks starten
          </button>
        </div>
      </div>

      {/* Check Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {QA_CHECKS.map(check => {
          const lastRun = lastRunByType[check.id]
          const isRunning = runningChecks.has(check.id) || lastRun?.status === 'running'
          const isDone = lastRun && !isRunning
          const isSuccess = isDone && lastRun.status === 'success'
          const isWarning = isDone && lastRun.status === 'warning'
          const isError = isDone && lastRun.status === 'error'
          const dur = lastRun?.finishedAt
            ? Math.round((new Date(lastRun.finishedAt).getTime() - new Date(lastRun.startedAt).getTime()) / 1000)
            : null
          const cardBorder = isRunning ? 'border-blue-300 shadow-blue-100 shadow-md'
            : isSuccess ? 'border-green-300'
            : isWarning ? 'border-amber-300'
            : isError ? 'border-red-300'
            : 'border-gray-200'
          return (
            <div key={check.id} className={`bg-white rounded-2xl p-5 border-2 flex flex-col gap-3 transition-all ${cardBorder}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{check.icon}</span>
                  <div>
                    <h3 className="font-bold text-gray-900 text-sm">{check.label}</h3>
                    {isRunning && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full text-blue-700 bg-blue-50 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3 animate-spin" /> Läuft...
                      </span>
                    )}
                    {isDone && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusColor(lastRun.status)}`}>
                        {statusEmoji(lastRun.status)} {isSuccess ? 'Fertig' : isWarning ? 'Warnung' : 'Fehler'}
                        {dur !== null && ` · ${dur}s`}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => runCheck(check.id)}
                  disabled={isRunning}
                  className="flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 text-indigo-700 font-medium px-3 py-1.5 rounded-lg text-xs transition-colors"
                >
                  {isRunning ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                  {isRunning ? 'Läuft...' : 'Starten'}
                </button>
              </div>
              <p className="text-xs text-gray-500">{check.desc}</p>
              {/* Fertig-Banner */}
              {isSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 font-medium">
                  ✅ Abgeschlossen · {new Date(lastRun.startedAt).toLocaleString('de-CH')}
                </div>
              )}
              {isWarning && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 font-medium">
                  ⚠️ Mit Warnungen · {new Date(lastRun.startedAt).toLocaleString('de-CH')}
                </div>
              )}
              {isError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 font-medium">
                  ❌ Fehler · {new Date(lastRun.startedAt).toLocaleString('de-CH')}
                </div>
              )}
              {lastRun?.summary && (
                <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2 font-mono border-t border-gray-100">
                  {Object.entries(lastRun.summary).slice(0, 4).map(([k, v]) => (
                    <div key={k}>{k}: <span className="font-semibold">{String(v)}</span></div>
                  ))}
                </div>
              )}
              {lastRun && (
                <button
                  onClick={() => setSelectedRun(selectedRun === lastRun.id ? null : lastRun.id)}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium text-left"
                >
                  {selectedRun === lastRun.id ? '▲ Details ausblenden' : '▼ Details anzeigen'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Run Items Detail */}
      {selectedRun !== null && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-gray-900">Check-Details (Run #{selectedRun})</h3>
            <button onClick={() => setSelectedRun(null)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>
          {loadingItems ? (
            <div className="text-center py-8 text-gray-400"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />Lade...</div>
          ) : runItems.length === 0 ? (
            <div className="text-center py-8 text-gray-400">Keine Einträge gefunden</div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {runItems.map(item => (
                <div key={item.id} className={`flex items-start gap-3 p-3 rounded-xl border text-sm ${itemStatusColor(item.status)}`}>
                  <span className="font-bold shrink-0 w-12 text-center">
                    {item.status === 'pass' ? '✅' : item.status === 'warn' ? '⚠️' : '❌'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{item.entityType}/{item.entityId}</div>
                    <div className="text-xs mt-0.5 opacity-80">{item.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
        {testAnalysis && (
          <div className="space-y-4">
            {/* Feature Vector */}
            {testAnalysis.featureVector && (<>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-blue-800 mb-3">🔬 Bild-Analyse (Feature-Vektor)</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Szenentyp</span>
                    <span className="text-blue-900 font-semibold capitalize">{(testAnalysis.featureVector as {sceneType: string}).sceneType.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Tile-Typ</span>
                    <span className={`font-semibold ${
                      (testAnalysis.featureVector as {tileType: string}).tileType === 'calm' ? 'text-green-700' :
                      (testAnalysis.featureVector as {tileType: string}).tileType === 'busy' ? 'text-red-700' : 'text-amber-700'
                    }`}>{(testAnalysis.featureVector as {tileType: string}).tileType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Textur</span>
                    <span className="text-blue-900">{(testAnalysis.featureVector as {textureLevel: string}).textureLevel} (Kanten: {(testAnalysis.featureVector as {edgeDensity: number}).edgeDensity})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Helligkeit</span>
                    <span className="text-blue-900">L={( testAnalysis.featureVector as {avgL: number}).avgL} · {(testAnalysis.featureVector as {brightnessRange: string}).brightnessRange}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Chroma</span>
                    <span className="text-blue-900">{(testAnalysis.featureVector as {avgChroma: number}).avgChroma}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-600 font-medium">Erkannt</span>
                    <span className="text-blue-900">
                      {(testAnalysis.featureVector as {facesDetected: boolean}).facesDetected && '👤 Gesicht '}
                      {(testAnalysis.featureVector as {skyDetected: boolean}).skyDetected && '☁️ Himmel '}
                      {(testAnalysis.featureVector as {waterDetected: boolean}).waterDetected && '🌊 Wasser '}
                      {!(testAnalysis.featureVector as {facesDetected: boolean; skyDetected: boolean; waterDetected: boolean}).facesDetected &&
                       !(testAnalysis.featureVector as {skyDetected: boolean}).skyDetected &&
                       !(testAnalysis.featureVector as {waterDetected: boolean}).waterDetected && '—'}
                    </span>
                  </div>
                </div>
                {(testAnalysis.featureVector as {dominantColors: string[]}).dominantColors?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(testAnalysis.featureVector as {dominantColors: string[]}).dominantColors.map((c: string) => (
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
            {/* Raw summary */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-400 hover:text-gray-600">Rohdaten anzeigen</summary>
              <pre className="mt-2 bg-gray-50 rounded-lg p-3 overflow-auto text-gray-600 max-h-48">{JSON.stringify(testAnalysis, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>

      {/* Run History */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="font-bold text-gray-900 mb-4">Run-Verlauf (letzte 50)</h3>
        {runs.length === 0 ? (
          <div className="text-center py-8 text-gray-400">Noch keine Checks ausgeführt. Starte einen Check oben.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="pb-2 pr-4">ID</th>
                  <th className="pb-2 pr-4">Check-Typ</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Gestartet</th>
                  <th className="pb-2 pr-4">Dauer</th>
                  <th className="pb-2">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 pr-4 text-gray-400 font-mono">#{run.id}</td>
                    <td className="py-2 pr-4 font-medium">{run.checkType}</td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor(run.status)}`}>
                        {statusEmoji(run.status)} {run.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-500 text-xs">{new Date(run.startedAt).toLocaleString('de-CH')}</td>
                    <td className="py-2 pr-4 text-gray-500 text-xs">
                      {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '—'}
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() => { setSelectedRun(run.id); fetchItems(run.id) }}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* ── Auto-Learn Cycle ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <span className="text-xl">🤖</span> Auto-Learn-Zyklus
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Vollautomatischer Zyklus: QA-Check → Lückenanalyse → Smart-Import → Reindex → QA-Nachcheck
            </p>
          </div>
          <button
            onClick={startAutoLearn}
            disabled={autoLearnRunning}
            className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-xl text-sm transition-colors"
          >
            {autoLearnRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {autoLearnRunning ? 'Läuft...' : 'Zyklus starten'}
          </button>
        </div>
        {/* Config */}
        <div className="flex flex-wrap gap-4 mb-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 shrink-0">Import-Anzahl:</label>
            <input
              type="number"
              value={autoLearnImportCount}
              onChange={e => setAutoLearnImportCount(Math.max(50, Math.min(2000, Number(e.target.value))))}
              className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1 text-center"
              min={50} max={2000} disabled={autoLearnRunning}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 shrink-0">Ziel pro Bucket:</label>
            <input
              type="number"
              value={autoLearnTargetPerBucket}
              onChange={e => setAutoLearnTargetPerBucket(Math.max(50, Math.min(1000, Number(e.target.value))))}
              className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1 text-center"
              min={50} max={1000} disabled={autoLearnRunning}
            />
          </div>
        </div>
        {/* Current run steps */}
        {autoLearnSteps.length > 0 && (
          <div className="space-y-1 mb-4">
            {autoLearnSteps.map((step, i) => (
              <div key={i} className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${
                step.status === 'done' ? 'bg-green-50 text-green-700' :
                step.status === 'running' ? 'bg-blue-50 text-blue-700' :
                step.status === 'skipped' ? 'bg-gray-50 text-gray-500' :
                step.status === 'error' ? 'bg-red-50 text-red-700' :
                'bg-gray-50 text-gray-600'
              }`}>
                <span className="shrink-0 mt-0.5">
                  {step.status === 'done' ? '✅' : step.status === 'running' ? '⏳' : step.status === 'skipped' ? '⏭️' : step.status === 'error' ? '❌' : '•'}
                </span>
                <span className="flex-1">{step.message}</span>
                <span className="text-gray-400 shrink-0">{new Date(step.ts).toLocaleTimeString('de-CH')}</span>
              </div>
            ))}
          </div>
        )}
        {/* Recent runs - collapsible */}
        {autoLearnRuns.length > 0 && (
          <div>
            <button
              onClick={() => setAutoLearnRunsExpanded(e => !e)}
              className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 hover:text-gray-700"
            >
              {autoLearnRunsExpanded ? '▲' : '▼'} Letzte Zyklen ({autoLearnRuns.length})
            </button>
            {!autoLearnRunsExpanded && autoLearnRuns[0] && (
              <div className="flex items-center gap-2 text-xs px-3 py-2 bg-gray-50 rounded-lg">
                <span className="font-mono text-gray-400">#{autoLearnRuns[0].id}</span>
                <span className={`font-medium px-2 py-0.5 rounded-full ${autoLearnRuns[0].status === 'success' ? 'bg-green-100 text-green-700' : autoLearnRuns[0].status === 'running' ? 'bg-blue-100 text-blue-700' : autoLearnRuns[0].status === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                  {autoLearnRuns[0].status === 'success' ? '✅' : autoLearnRuns[0].status === 'running' ? '⏳' : autoLearnRuns[0].status === 'error' ? '❌' : '⚠️'} {autoLearnRuns[0].status}
                </span>
                <span className="text-gray-400">{new Date(autoLearnRuns[0].started_at).toLocaleString('de-CH')}</span>
              </div>
            )}
            {autoLearnRunsExpanded && (
              <div className="space-y-1">
                {autoLearnRuns.slice(0, 5).map(run => (
                  <div key={run.id} className="flex items-center gap-3 text-xs px-3 py-2 bg-gray-50 rounded-lg">
                    <span className="font-mono text-gray-400">#{run.id}</span>
                    <span className={`font-medium px-2 py-0.5 rounded-full ${
                      run.status === 'success' ? 'bg-green-100 text-green-700' :
                      run.status === 'running' ? 'bg-blue-100 text-blue-700' :
                      run.status === 'error' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {run.status === 'success' ? '\u2705' : run.status === 'running' ? '\u23f3' : run.status === 'error' ? '\u274c' : '\u26a0\ufe0f'} {run.status}
                    </span>
                    <span className="text-gray-500">{new Date(run.started_at).toLocaleString('de-CH')}</span>
                    {run.finished_at && (
                      <span className="text-gray-400">
                        {Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s
                      </span>
                    )}
                    <button
                      onClick={() => setAutoLearnExpandedRun(autoLearnExpandedRun === run.id ? null : run.id)}
                      className="ml-auto text-indigo-500 hover:text-indigo-700"
                    >
                      {autoLearnExpandedRun === run.id ? '\u25b2' : '\u25bc'}
                    </button>
                  </div>
                ))}
                {autoLearnExpandedRun !== null && (() => {
                  const run = autoLearnRuns.find(r => r.id === autoLearnExpandedRun)
                  if (!run || !run.steps_json) return null
                  const steps = Array.isArray(run.steps_json) ? run.steps_json : []
                  return (
                    <div className="mt-2 space-y-1 pl-4">
                      {steps.map((step: {step: string; status: string; message: string; ts: string}, i: number) => (
                        <div key={i} className={`text-xs px-3 py-1.5 rounded-lg ${
                          step.status === 'done' ? 'bg-green-50 text-green-700' :
                          step.status === 'running' ? 'bg-blue-50 text-blue-700' :
                          step.status === 'error' ? 'bg-red-50 text-red-700' :
                          'bg-gray-50 text-gray-500'
                        }`}>
                          {step.status === 'done' ? '\u2705' : step.status === 'running' ? '\u23f3' : step.status === 'error' ? '\u274c' : '\u23ed\ufe0f'} {step.message}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Semantic Auto-Tagger ──────────────────────────────────────────────────────────── */}
      <SemanticTaggerPanel onMessage={onMessage} />

    </div>
  )
}

// ── Semantic Tagger Panel ────────────────────────────────────────────────
function SemanticTaggerPanel({ onMessage }: { onMessage: (m: { text: string; type: 'success' | 'error' | 'info' }) => void }) {
  const [running, setRunning] = useState(false)
  const [forceRetag, setForceRetag] = useState(false)
  const [result, setResult] = useState<{ tagged: number; skipped: number } | null>(null)
  const [stats, setStats] = useState<Array<{ theme: string; count: number; pct: number }> | null>(null)
  const [open, setOpen] = useState(true)

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/trpc/getSemanticThemeStats')
      const data = await res.json()
      const rows = data.result?.data?.json ?? data.result?.data ?? []
      setStats(rows)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  const runTagger = useCallback(async () => {
    if (!forceRetag && !confirm('Alle Tiles ohne Semantic-Tag automatisch klassifizieren? (Kann bei 22.000+ Tiles 1-2 Minuten dauern)')) return
    if (forceRetag && !confirm('ALLE Tiles (auch bereits getaggte) neu klassifizieren? (Dauert bei 22.000+ Tiles 2-3 Minuten)')) return
    setRunning(true); setResult(null)
    try {
      const res = await fetch('/api/trpc/runSemanticTagger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRetag })
      })
      const data = await res.json()
      const r = data.result?.data?.json ?? data.result?.data ?? {}
      setResult({ tagged: r.tagged ?? 0, skipped: r.skipped ?? 0 })
      onMessage({ text: `✅ Semantic-Tagger: ${r.tagged ?? 0} Tiles getaggt`, type: 'success' })
      fetchStats()
    } catch (e) {
      onMessage({ text: `❌ Tagger-Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setRunning(false)
    }
  }, [forceRetag, onMessage, fetchStats])

  const THEME_COLORS: Record<string, string> = {
    portrait: '#f97316', nature_forest: '#22c55e', nature_ocean: '#06b6d4',
    nature_sunset: '#f59e0b', city_night: '#6366f1', abstract_colorful: '#ec4899',
    abstract_dark: '#374151', abstract_light: '#d1d5db', nature_snow: '#bfdbfe',
    nature_warm: '#fbbf24', untagged: '#9ca3af',
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-3">
          <span className="text-xl">🏷️</span>
          <div className="text-left">
            <h3 className="font-bold text-gray-900">Semantic Auto-Tagger</h3>
            <p className="text-xs text-gray-500">
              Klassifiziert Tiles automatisch nach Thema (Portrait, Natur, Nacht, etc.) anhand der LAB-Farbwerte.
              {stats && ` · ${stats.find(s => s.theme === 'untagged')?.count?.toLocaleString('de-CH') ?? 0} ungetaggt`}
            </p>
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲ Einklappen' : '▼ Anzeigen'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-5 space-y-5">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={runTagger}
              disabled={running}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors"
            >
              {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <span>🏷️</span>}
              {running ? 'Tagge Tiles...' : (forceRetag ? 'Alle neu taggen' : 'Ungetaggte taggen')}
            </button>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={forceRetag}
                onChange={e => setForceRetag(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              Alle Tiles neu klassifizieren (Force-Retag)
            </label>
            <button onClick={fetchStats} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Statistik aktualisieren
            </button>
          </div>

          {/* Result */}
          {result && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
              <span className="text-2xl">✅</span>
              <div>
                <div className="font-semibold text-green-800">{result.tagged.toLocaleString('de-CH')} Tiles getaggt</div>
                <div className="text-xs text-green-600">{result.skipped.toLocaleString('de-CH')} übersprungen (bereits getaggt)</div>
              </div>
            </div>
          )}

          {/* Theme Distribution */}
          {stats && stats.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Themen-Verteilung</h4>
              <div className="space-y-2">
                {stats.map(s => (
                  <div key={s.theme} className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: THEME_COLORS[s.theme] ?? '#9ca3af' }}
                    />
                    <div className="w-40 text-xs text-gray-700 shrink-0 truncate">{s.theme}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-2">
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{ width: `${Math.min(100, s.pct)}%`, backgroundColor: THEME_COLORS[s.theme] ?? '#9ca3af' }}
                      />
                    </div>
                    <div className="w-20 text-right text-xs text-gray-500">{s.count.toLocaleString('de-CH')} ({s.pct}%)</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-xs text-gray-400">
                Gesamt: {stats.reduce((s, r) => s + r.count, 0).toLocaleString('de-CH')} Tiles
              </div>
            </div>
          )}

          {/* Info Box */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <h4 className="text-xs font-bold text-blue-700 uppercase tracking-wider mb-2">Wie funktioniert der Tagger?</h4>
            <p className="text-xs text-blue-700">
              Der Tagger analysiert die LAB-Farbwerte jedes Tiles (kein Bild-Download nötig) und klassifiziert es in eine von 10+ Kategorien:
              Portrait (Hauttöne), Natur-Wald (Grün), Natur-Ozean (Blau/Cyan), Natur-Sonnenuntergang (Orange/Rot),
              Nacht/Skyline (Dunkel), Abstrakt-Bunt (hohe Sättigung), Abstrakt-Hell, Abstrakt-Dunkel, Natur-Schnee (Hell/Neutral), Natur-Warm.
              Diese Tags ermöglichen thematisches Filtering im Studio und gezielteres Smart-Import.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
