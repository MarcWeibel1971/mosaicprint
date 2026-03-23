import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Trash2, RefreshCw, Calendar, Plus, ArrowLeft, Upload, Image, X, Play, Camera, QrCode, Link as LinkIcon, ChevronDown, ChevronUp, Users, Mail, Send } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

interface Project {
  id: number
  name: string
  thumbnail_url: string | null
  tile_source_mode: string | null
  project_type: string | null
  created_at: string
  updated_at: string
}

interface ProjectDetail extends Project {
  data: any
  user_tiles: string[] | null
}

interface EventItem {
  id: number
  slug: string
  name: string
  status: string
  max_photos: number
  photo_count: number
  target_image_url: string | null
  created_at: string
  updated_at?: string
}

// Unified item for the grid
interface GridItem {
  type: 'mosaic' | 'event'
  id: number
  name: string
  thumbnail_url: string | null
  tile_source_mode: string | null
  created_at: string
  updated_at: string
  // Event-specific
  event?: EventItem
}

const SOURCE_MODE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  pool: { label: 'Pool', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
  own: { label: 'Eigene Bilder', color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
  mix: { label: 'Mix', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  event: { label: 'Event', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
}

function SourceModeTag({ mode }: { mode: string | null }) {
  const info = SOURCE_MODE_LABELS[mode || 'pool'] || SOURCE_MODE_LABELS.pool
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${info.bg} ${info.color}`}>
      {info.label}
    </span>
  )
}

export default function Projects() {
  const { user, authHeaders } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null) // "mosaic-ID" or "event-SLUG"

  // Detail view state
  const [selectedProject, setSelectedProject] = useState<ProjectDetail | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [userTiles, setUserTiles] = useState<string[]>([])
  const [savingTiles, setSavingTiles] = useState(false)
  const [tilesChanged, setTilesChanged] = useState(false)
  const tileUploadRef = useRef<HTMLInputElement>(null)

  // Event detail state
  const [qrData, setQrData] = useState<{ qrDataUrl: string; eventUrl: string } | null>(null)
  const [participants, setParticipants] = useState<Array<{ id: number; name: string; email: string; created_at: string }>>([])
  const [showParticipants, setShowParticipants] = useState(false)
  const [sendingMosaic, setSendingMosaic] = useState(false)
  const [uploadingTarget, setUploadingTarget] = useState(false)
  const [eventMessage, setEventMessage] = useState<string | null>(null)
  const targetImageRef = useRef<HTMLInputElement>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [projRes, eventRes] = await Promise.all([
        fetch('/api/projects', { headers: authHeaders() }),
        fetch('/api/my-events', { headers: authHeaders() }),
      ])
      const projData = await projRes.json()
      const eventData = await eventRes.json()
      if (projData.ok) setProjects(projData.projects)
      if (eventData.ok) setEvents(eventData.events ?? [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [authHeaders])

  useEffect(() => {
    if (!user) { navigate('/login'); return }
    fetchAll()
  }, [user, navigate, fetchAll])

  // Build unified grid items sorted by updated_at
  const gridItems: GridItem[] = [
    ...projects.map(p => ({
      type: 'mosaic' as const,
      id: p.id,
      name: p.name,
      thumbnail_url: p.thumbnail_url,
      tile_source_mode: p.tile_source_mode,
      created_at: p.created_at,
      updated_at: p.updated_at,
    })),
    ...events.map(e => ({
      type: 'event' as const,
      id: e.id,
      name: e.name,
      thumbnail_url: e.target_image_url,
      tile_source_mode: 'event',
      created_at: e.created_at,
      updated_at: e.updated_at || e.created_at,
      event: e,
    })),
  ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

  const handleDeleteMosaic = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!confirm('Projekt wirklich loeschen?')) return
    setDeleting(`mosaic-${id}`)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: authHeaders() })
      setProjects(prev => prev.filter(p => p.id !== id))
      if (selectedProject?.id === id) setSelectedProject(null)
    } catch { /* ignore */ }
    finally { setDeleting(null) }
  }

  const handleDeleteEvent = async (slug: string, name: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!confirm(`Event "${name}" wirklich loeschen? Alle Gaestefotos werden entfernt.`)) return
    setDeleting(`event-${slug}`)
    try {
      await fetch(`/api/events/${slug}`, { method: 'DELETE', headers: authHeaders() })
      setEvents(prev => prev.filter(ev => ev.slug !== slug))
      if (selectedEvent?.slug === slug) { setSelectedEvent(null); setQrData(null) }
    } catch { /* ignore */ }
    finally { setDeleting(null) }
  }

  const handleLoadMosaic = (id: number) => {
    navigate(`/studio?project=${id}`)
  }

  // Open mosaic project detail
  const openMosaicDetail = async (projectId: number) => {
    setDetailLoading(true)
    setSelectedEvent(null)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { headers: authHeaders() })
      const result = await res.json()
      if (result.ok) {
        const project = result.project as ProjectDetail
        if (typeof project.data === 'string') project.data = JSON.parse(project.data)
        if (typeof project.user_tiles === 'string') project.user_tiles = JSON.parse(project.user_tiles)
        setSelectedProject(project)
        setUserTiles(project.user_tiles || [])
        setTilesChanged(false)
      }
    } catch (e) {
      console.warn('[Projects] Failed to load detail:', e)
    } finally {
      setDetailLoading(false)
    }
  }

  // Open event detail
  const openEventDetail = async (event: EventItem) => {
    setSelectedProject(null)
    setSelectedEvent(event)
    setShowParticipants(false)
    setQrData(null)
    setEventMessage(null)
    // Load QR code
    try {
      const res = await fetch(`/api/events/${event.slug}/qr-data`)
      const data = await res.json()
      if (data.ok) setQrData({ qrDataUrl: data.qrDataUrl, eventUrl: data.eventUrl })
    } catch { /* ignore */ }
  }

  const loadParticipants = async (slug: string) => {
    try {
      const res = await fetch(`/api/events/${slug}/participants`, { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setParticipants(data.participants)
    } catch { /* ignore */ }
  }

  const sendMosaic = async (slug: string) => {
    if (sendingMosaic) return
    if (!confirm('Mosaik jetzt generieren und an alle registrierten Teilnehmer senden?')) return
    setSendingMosaic(true)
    setEventMessage('Mosaik wird generiert und versendet...')
    try {
      const res = await fetch(`/api/events/${slug}/send-mosaic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      })
      const data = await res.json()
      if (data.ok) {
        setEventMessage(`Mosaik an ${data.sent} von ${data.total} Teilnehmern gesendet!`)
      } else {
        setEventMessage(`Fehler: ${data.error}`)
      }
    } catch (e) {
      setEventMessage(`Fehler: ${String(e)}`)
    } finally {
      setSendingMosaic(false)
    }
  }

  const uploadTargetImage = async (slug: string, file: File) => {
    setUploadingTarget(true)
    try {
      const reader = new FileReader()
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await fetch(`/api/events/${slug}/target-image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ targetImageBase64: base64 }),
      })
      const data = await res.json()
      if (data.ok) {
        setEventMessage('Zielbild hochgeladen!')
        fetchAll()
      } else {
        setEventMessage(`Fehler: ${data.error}`)
      }
    } catch (e) {
      setEventMessage(`Fehler: ${String(e)}`)
    } finally {
      setUploadingTarget(false)
    }
  }

  // Tile management for mosaic projects
  const handleTileUpload = (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const HR_SIZE = 512
    const loadPromises = imageFiles.map(file => new Promise<string | null>(resolve => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new window.Image()
        img.onload = () => {
          const s = Math.min(img.naturalWidth, img.naturalHeight)
          const sx = (img.naturalWidth - s) / 2
          const sy = (img.naturalHeight - s) / 2
          const size = Math.min(HR_SIZE, s)
          const canvas = document.createElement('canvas')
          canvas.width = size; canvas.height = size
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
          resolve(canvas.toDataURL('image/jpeg', 0.92))
        }
        img.onerror = () => resolve(null)
        img.src = e.target?.result as string
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    }))
    Promise.all(loadPromises).then(results => {
      const valid = results.filter(Boolean) as string[]
      if (valid.length > 0) {
        setUserTiles(prev => [...prev, ...valid])
        setTilesChanged(true)
      }
    })
  }

  const removeTile = (index: number) => {
    setUserTiles(prev => prev.filter((_, i) => i !== index))
    setTilesChanged(true)
  }

  const saveTiles = async () => {
    if (!selectedProject) return
    setSavingTiles(true)
    try {
      const res = await fetch(`/api/projects/${selectedProject.id}/tiles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userTiles: userTiles }),
      })
      const result = await res.json()
      if (result.ok) {
        setTilesChanged(false)
        setSelectedProject(prev => prev ? { ...prev, user_tiles: userTiles } : null)
      }
    } catch (e) {
      console.warn('[Projects] Failed to save tiles:', e)
    } finally {
      setSavingTiles(false)
    }
  }

  if (!user) return null

  // ── Event Detail View ────────────────────────────────────────────────────
  if (selectedEvent) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-cream-50 to-white">
        <section className="max-w-5xl mx-auto px-6 py-12">
          <button onClick={() => { setSelectedEvent(null); setQrData(null) }} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Zurueck zu Projekten
          </button>

          <div className="flex items-start gap-6 mb-8">
            {/* Target image */}
            <div className="w-48 h-48 rounded-2xl overflow-hidden border border-cream-200 bg-gray-100 flex-shrink-0">
              {selectedEvent.target_image_url ? (
                <img src={selectedEvent.target_image_url} alt={selectedEvent.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Camera className="w-12 h-12 text-gray-300" />
                </div>
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h1 className="font-serif text-2xl text-gray-900">{selectedEvent.name}</h1>
                <SourceModeTag mode="event" />
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${selectedEvent.status === 'active' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-500 border border-gray-200'}`}>
                  {selectedEvent.status === 'active' ? 'Aktiv' : 'Beendet'}
                </span>
              </div>
              <p className="text-sm text-gray-400 flex items-center gap-1 mb-1">
                <Camera className="w-3.5 h-3.5" />
                {selectedEvent.photo_count} / {selectedEvent.max_photos} Fotos
              </p>
              <p className="text-sm text-gray-400 flex items-center gap-1 mb-4">
                <Calendar className="w-3.5 h-3.5" />
                Erstellt am {new Date(selectedEvent.created_at).toLocaleDateString('de-CH')}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <a href={`/event/${selectedEvent.slug}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md transition-all">
                  <Play className="w-4 h-4" /> Event oeffnen
                </a>
                <button onClick={() => {
                  const url = `${window.location.origin}/event/${selectedEvent.slug}`
                  navigator.clipboard.writeText(url)
                  setEventMessage('Link kopiert!')
                }} className="inline-flex items-center gap-2 text-sm text-blue-600 font-medium px-4 py-2.5 rounded-full border border-blue-200 hover:bg-blue-50 transition-all">
                  <LinkIcon className="w-4 h-4" /> Link kopieren
                </button>
                <button onClick={() => targetImageRef.current?.click()} disabled={uploadingTarget}
                  className="inline-flex items-center gap-2 text-sm text-orange-600 font-medium px-4 py-2.5 rounded-full border border-orange-200 hover:bg-orange-50 transition-all">
                  {uploadingTarget ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Zielbild
                </button>
                <button onClick={() => handleDeleteEvent(selectedEvent.slug, selectedEvent.name)}
                  disabled={deleting === `event-${selectedEvent.slug}`}
                  className="inline-flex items-center gap-2 text-sm text-red-500 font-medium px-4 py-2.5 rounded-full border border-red-200 hover:bg-red-50 transition-all">
                  {deleting === `event-${selectedEvent.slug}` ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Loeschen
                </button>
              </div>
            </div>
          </div>

          {eventMessage && (
            <div className="rounded-xl px-4 py-3 text-sm font-medium bg-green-50 text-green-700 border border-green-200 mb-6">
              {eventMessage}
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-6">
            {/* QR Code */}
            {qrData && (
              <div className="bg-white rounded-2xl border border-cream-200 p-6 text-center">
                <h3 className="font-bold text-gray-900 mb-3 flex items-center justify-center gap-2">
                  <QrCode className="w-5 h-5 text-purple-500" /> QR-Code
                </h3>
                <img src={qrData.qrDataUrl} alt="QR Code" className="w-48 h-48 mx-auto mb-3 rounded-xl border border-gray-200" />
                <p className="text-xs text-gray-400 break-all mb-3">{qrData.eventUrl}</p>
                <a href={`/api/events/${selectedEvent.slug}/qr?format=png`} download={`qr-${selectedEvent.slug}.png`}
                  className="inline-flex items-center gap-1.5 bg-coral-500 hover:bg-coral-600 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors">
                  PNG herunterladen
                </a>
              </div>
            )}

            {/* Participants */}
            <div className="bg-white rounded-2xl border border-cream-200 p-6">
              <button onClick={() => { setShowParticipants(!showParticipants); if (!showParticipants) loadParticipants(selectedEvent.slug) }}
                className="w-full flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-900 flex items-center gap-2">
                  <Users className="w-5 h-5 text-amber-500" /> Teilnehmer
                </h3>
                {showParticipants ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
              {showParticipants && (
                <div>
                  {participants.length === 0 ? (
                    <p className="text-sm text-gray-400 py-2">Noch keine Teilnehmer registriert.</p>
                  ) : (
                    <>
                      <div className="space-y-2 mb-3">
                        {participants.map(p => (
                          <div key={p.id} className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2">
                            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-xs font-bold">
                              {p.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800">{p.name}</p>
                              <p className="text-xs text-gray-500 truncate">{p.email}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => sendMosaic(selectedEvent.slug)} disabled={sendingMosaic}
                        className="w-full flex items-center justify-center gap-2 bg-coral-500 hover:bg-coral-600 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2.5 rounded-lg transition-colors">
                        {sendingMosaic ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        Mosaik an alle senden
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <input ref={targetImageRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadTargetImage(selectedEvent.slug, f); e.target.value = '' }} />
        </section>
      </div>
    )
  }

  // ── Mosaic Project Detail View ────────────────────────────────────────────
  if (selectedProject) {
    const isOwnMode = selectedProject.tile_source_mode === 'own' || selectedProject.tile_source_mode === 'mix'
    return (
      <div className="min-h-screen bg-gradient-to-b from-cream-50 to-white">
        <section className="max-w-5xl mx-auto px-6 py-12">
          <button onClick={() => setSelectedProject(null)} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Zurueck zu Projekten
          </button>

          <div className="flex items-start gap-6 mb-8">
            <div className="w-48 h-48 rounded-2xl overflow-hidden border border-cream-200 bg-gray-100 flex-shrink-0">
              {selectedProject.thumbnail_url ? (
                <img src={selectedProject.thumbnail_url} alt={selectedProject.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center"><FolderOpen className="w-12 h-12 text-gray-300" /></div>
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h1 className="font-serif text-2xl text-gray-900">{selectedProject.name}</h1>
                <SourceModeTag mode={selectedProject.tile_source_mode} />
              </div>
              <p className="text-sm text-gray-400 flex items-center gap-1 mb-4">
                <Calendar className="w-3.5 h-3.5" />
                Erstellt am {new Date(selectedProject.created_at).toLocaleDateString('de-CH')} |
                Aktualisiert am {new Date(selectedProject.updated_at).toLocaleDateString('de-CH')}
              </p>
              <div className="flex items-center gap-3">
                <button onClick={() => handleLoadMosaic(selectedProject.id)}
                  className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md transition-all">
                  <Play className="w-4 h-4" /> Im Studio oeffnen
                </button>
                <button onClick={() => handleDeleteMosaic(selectedProject.id)} disabled={deleting === `mosaic-${selectedProject.id}`}
                  className="inline-flex items-center gap-2 text-sm text-red-500 hover:text-red-600 font-medium px-4 py-2.5 rounded-full border border-red-200 hover:bg-red-50 transition-all">
                  {deleting === `mosaic-${selectedProject.id}` ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Loeschen
                </button>
              </div>
            </div>
          </div>

          {isOwnMode && (
            <div className="bg-white rounded-2xl border border-purple-100 shadow-sm p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Meine Fotos</h2>
                  <p className="text-sm text-gray-500">{userTiles.length} Bilder hochgeladen. Fotos hinzufuegen oder entfernen und dann im Studio neu rendern.</p>
                </div>
                <div className="flex items-center gap-2">
                  {tilesChanged && (
                    <button onClick={saveTiles} disabled={savingTiles}
                      className="inline-flex items-center gap-2 bg-purple-500 hover:bg-purple-600 text-white font-semibold text-sm px-4 py-2 rounded-full shadow-sm transition-all disabled:opacity-50">
                      {savingTiles ? <RefreshCw className="w-4 h-4 animate-spin" /> : null} Aenderungen speichern
                    </button>
                  )}
                  <button onClick={() => tileUploadRef.current?.click()}
                    className="inline-flex items-center gap-2 bg-purple-50 hover:bg-purple-100 text-purple-700 font-semibold text-sm px-4 py-2 rounded-full border border-purple-200 transition-all">
                    <Upload className="w-4 h-4" /> Fotos hinzufuegen
                  </button>
                  <input ref={tileUploadRef} type="file" multiple accept="image/*" className="hidden"
                    onChange={e => e.target.files && handleTileUpload(e.target.files)} />
                </div>
              </div>
              {userTiles.length === 0 ? (
                <div className="border-2 border-dashed border-purple-200 rounded-xl p-8 text-center cursor-pointer hover:border-purple-400 transition-colors"
                  onClick={() => tileUploadRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); handleTileUpload(e.dataTransfer.files) }}>
                  <Image className="w-10 h-10 text-purple-300 mx-auto mb-2" />
                  <p className="text-sm text-purple-500 font-medium">Fotos hierher ziehen oder klicken zum Hochladen</p>
                  <p className="text-xs text-gray-400 mt-1">JPG, PNG - mind. 20 Bilder empfohlen</p>
                </div>
              ) : (
                <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2"
                  onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); handleTileUpload(e.dataTransfer.files) }}>
                  {userTiles.map((tile, i) => (
                    <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border border-gray-200">
                      <img src={tile} alt="" className="w-full h-full object-cover" />
                      <button onClick={() => removeTile(i)} className="absolute top-0.5 right-0.5 p-0.5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <div className="aspect-square rounded-lg border-2 border-dashed border-purple-200 flex items-center justify-center cursor-pointer hover:border-purple-400 transition-colors"
                    onClick={() => tileUploadRef.current?.click()}>
                    <Plus className="w-5 h-5 text-purple-400" />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid sm:grid-cols-3 gap-4">
            {selectedProject.data?.mosaicParams && (
              <div className="bg-white rounded-xl border border-cream-200 p-4">
                <p className="text-xs text-gray-400 mb-1">Raster</p>
                <p className="text-lg font-bold text-gray-800">{selectedProject.data.mosaicParams.cols} x {selectedProject.data.mosaicParams.rows}</p>
                <p className="text-xs text-gray-400">{selectedProject.data.mosaicParams.cols * selectedProject.data.mosaicParams.rows} Kacheln</p>
              </div>
            )}
            {selectedProject.data?.qualityMetrics && (
              <div className="bg-white rounded-xl border border-cream-200 p-4">
                <p className="text-xs text-gray-400 mb-1">Farbqualitaet</p>
                <p className="text-lg font-bold text-gray-800">{selectedProject.data.qualityMetrics.avgDeltaE?.toFixed(1) || '–'} Delta-E</p>
                <p className="text-xs text-gray-400">{selectedProject.data.qualityMetrics.matchedTiles || '–'} Tiles zugeordnet</p>
              </div>
            )}
            <div className="bg-white rounded-xl border border-cream-200 p-4">
              <p className="text-xs text-gray-400 mb-1">Tile-Quelle</p>
              <p className="text-lg font-bold text-gray-800">{SOURCE_MODE_LABELS[selectedProject.tile_source_mode || 'pool']?.label || 'Pool'}</p>
              {isOwnMode && <p className="text-xs text-gray-400">{userTiles.length} eigene Fotos</p>}
            </div>
          </div>
        </section>
      </div>
    )
  }

  // ── Project List View ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-cream-50 to-white">
      <section className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-serif text-3xl text-gray-900 mb-1">Meine Projekte</h1>
            <p className="text-gray-500">Deine gespeicherten Mosaik-Projekte und Events.</p>
          </div>
          <Link to="/studio"
            className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md transition-all">
            <Plus className="w-4 h-4" /> Neues Mosaik
          </Link>
        </div>

        {loading || detailLoading ? (
          <div className="flex justify-center py-16"><RefreshCw className="w-6 h-6 text-coral-400 animate-spin" /></div>
        ) : gridItems.length === 0 ? (
          <div className="bg-white rounded-2xl border border-cream-200 p-12 text-center">
            <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-1 font-medium">Noch keine Projekte</p>
            <p className="text-sm text-gray-400 mb-4">Erstelle ein Mosaik im Studio oder ein Event.</p>
            <div className="flex gap-3 justify-center">
              <Link to="/studio" className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full transition-all">Zum Studio</Link>
              <Link to="/events" className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full transition-all">Event erstellen</Link>
            </div>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {gridItems.map(item => (
              <div
                key={`${item.type}-${item.id}`}
                className="group bg-white rounded-2xl border border-cream-200 hover:border-coral-300 hover:shadow-lg transition-all overflow-hidden cursor-pointer"
                onClick={() => item.type === 'mosaic' ? openMosaicDetail(item.id) : openEventDetail(item.event!)}
              >
                <div className="aspect-square bg-gray-100 overflow-hidden relative">
                  {item.thumbnail_url ? (
                    <img src={item.thumbnail_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {item.type === 'event' ? <Camera className="w-12 h-12 text-gray-300" /> : <FolderOpen className="w-12 h-12 text-gray-300" />}
                    </div>
                  )}
                  <div className="absolute top-2 left-2">
                    <SourceModeTag mode={item.tile_source_mode} />
                  </div>
                  {item.type === 'event' && item.event && (
                    <div className="absolute bottom-2 right-2">
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/90 text-gray-700 border border-gray-200">
                        <Camera className="w-3 h-3" />
                        {item.event.photo_count} / {item.event.max_photos}
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-gray-900 mb-1 truncate">{item.name}</h3>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {new Date(item.updated_at).toLocaleDateString('de-CH')}
                    </span>
                    <div className="flex items-center gap-1">
                      {item.type === 'mosaic' ? (
                        <>
                          <button onClick={(e) => { e.stopPropagation(); handleLoadMosaic(item.id) }}
                            className="text-xs text-coral-600 hover:text-coral-700 font-medium px-2 py-1 rounded-lg hover:bg-coral-50 transition-colors">Studio</button>
                          <button onClick={(e) => handleDeleteMosaic(item.id, e)} disabled={deleting === `mosaic-${item.id}`}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            {deleting === `mosaic-${item.id}` ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      ) : (
                        <>
                          <a href={`/event/${item.event!.slug}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                            className="text-xs text-coral-600 hover:text-coral-700 font-medium px-2 py-1 rounded-lg hover:bg-coral-50 transition-colors">Oeffnen</a>
                          <button onClick={(e) => handleDeleteEvent(item.event!.slug, item.name, e)} disabled={deleting === `event-${item.event!.slug}`}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            {deleting === `event-${item.event!.slug}` ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
