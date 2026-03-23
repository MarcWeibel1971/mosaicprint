import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Trash2, RefreshCw, Calendar, Plus, ArrowLeft, Upload, Image, X, Play } from 'lucide-react'
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

const SOURCE_MODE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  pool: { label: 'Pool', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
  own: { label: 'Eigene Bilder', color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
  mix: { label: 'Mix', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
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
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)

  // Detail view state
  const [selectedProject, setSelectedProject] = useState<ProjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [userTiles, setUserTiles] = useState<string[]>([])
  const [savingTiles, setSavingTiles] = useState(false)
  const [tilesChanged, setTilesChanged] = useState(false)
  const tileUploadRef = useRef<HTMLInputElement>(null)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', { headers: authHeaders() })
      const data = await res.json()
      if (data.ok) setProjects(data.projects)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [authHeaders])

  useEffect(() => {
    if (!user) { navigate('/login'); return }
    fetchProjects()
  }, [user, navigate, fetchProjects])

  const handleDelete = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!confirm('Projekt wirklich loeschen?')) return
    setDeleting(id)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: authHeaders() })
      setProjects(prev => prev.filter(p => p.id !== id))
      if (selectedProject?.id === id) setSelectedProject(null)
    } catch { /* ignore */ }
    finally { setDeleting(null) }
  }

  const handleLoad = (id: number) => {
    navigate(`/studio?project=${id}`)
  }

  // Open project detail view
  const openDetail = async (projectId: number) => {
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { headers: authHeaders() })
      const result = await res.json()
      if (result.ok) {
        const project = result.project as ProjectDetail
        // Parse data if it's a string
        if (typeof project.data === 'string') project.data = JSON.parse(project.data)
        // Parse user_tiles if it's a string
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

  // Handle tile upload in detail view
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

  // Save updated tiles to server
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
        // Update the project in the list
        setSelectedProject(prev => prev ? { ...prev, user_tiles: userTiles } : null)
      }
    } catch (e) {
      console.warn('[Projects] Failed to save tiles:', e)
    } finally {
      setSavingTiles(false)
    }
  }

  if (!user) return null

  // ── Detail View ──────────────────────────────────────────────────────────
  if (selectedProject) {
    const isOwnMode = selectedProject.tile_source_mode === 'own' || selectedProject.tile_source_mode === 'mix'
    return (
      <div className="min-h-screen bg-gradient-to-b from-cream-50 to-white">
        <section className="max-w-5xl mx-auto px-6 py-12">
          {/* Back button */}
          <button
            onClick={() => setSelectedProject(null)}
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Zurueck zu Projekten
          </button>

          {/* Project header */}
          <div className="flex items-start gap-6 mb-8">
            {/* Thumbnail */}
            <div className="w-48 h-48 rounded-2xl overflow-hidden border border-cream-200 bg-gray-100 flex-shrink-0">
              {selectedProject.thumbnail_url ? (
                <img
                  src={selectedProject.thumbnail_url}
                  alt={selectedProject.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <FolderOpen className="w-12 h-12 text-gray-300" />
                </div>
              )}
            </div>

            {/* Info */}
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

              {/* Action buttons */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleLoad(selectedProject.id)}
                  className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md transition-all"
                >
                  <Play className="w-4 h-4" />
                  Im Studio oeffnen
                </button>
                <button
                  onClick={() => handleDelete(selectedProject.id)}
                  disabled={deleting === selectedProject.id}
                  className="inline-flex items-center gap-2 text-sm text-red-500 hover:text-red-600 font-medium px-4 py-2.5 rounded-full border border-red-200 hover:bg-red-50 transition-all"
                >
                  {deleting === selectedProject.id ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Loeschen
                </button>
              </div>
            </div>
          </div>

          {/* ── Photo Management for own/mix mode ─────────────────────────── */}
          {isOwnMode && (
            <div className="bg-white rounded-2xl border border-purple-100 shadow-sm p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Meine Fotos</h2>
                  <p className="text-sm text-gray-500">
                    {userTiles.length} Bilder hochgeladen.
                    Fotos hinzufuegen oder entfernen und dann im Studio neu rendern.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {tilesChanged && (
                    <button
                      onClick={saveTiles}
                      disabled={savingTiles}
                      className="inline-flex items-center gap-2 bg-purple-500 hover:bg-purple-600 text-white font-semibold text-sm px-4 py-2 rounded-full shadow-sm transition-all disabled:opacity-50"
                    >
                      {savingTiles ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                      Aenderungen speichern
                    </button>
                  )}
                  <button
                    onClick={() => tileUploadRef.current?.click()}
                    className="inline-flex items-center gap-2 bg-purple-50 hover:bg-purple-100 text-purple-700 font-semibold text-sm px-4 py-2 rounded-full border border-purple-200 transition-all"
                  >
                    <Upload className="w-4 h-4" />
                    Fotos hinzufuegen
                  </button>
                  <input
                    ref={tileUploadRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={e => e.target.files && handleTileUpload(e.target.files)}
                  />
                </div>
              </div>

              {/* Photo grid */}
              {userTiles.length === 0 ? (
                <div
                  className="border-2 border-dashed border-purple-200 rounded-xl p-8 text-center cursor-pointer hover:border-purple-400 transition-colors"
                  onClick={() => tileUploadRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); handleTileUpload(e.dataTransfer.files) }}
                >
                  <Image className="w-10 h-10 text-purple-300 mx-auto mb-2" />
                  <p className="text-sm text-purple-500 font-medium">Fotos hierher ziehen oder klicken zum Hochladen</p>
                  <p className="text-xs text-gray-400 mt-1">JPG, PNG - mind. 20 Bilder empfohlen</p>
                </div>
              ) : (
                <div
                  className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2"
                  onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); handleTileUpload(e.dataTransfer.files) }}
                >
                  {userTiles.map((tile, i) => (
                    <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border border-gray-200">
                      <img src={tile} alt="" className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeTile(i)}
                        className="absolute top-0.5 right-0.5 p-0.5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {/* Add more button */}
                  <div
                    className="aspect-square rounded-lg border-2 border-dashed border-purple-200 flex items-center justify-center cursor-pointer hover:border-purple-400 transition-colors"
                    onClick={() => tileUploadRef.current?.click()}
                  >
                    <Plus className="w-5 h-5 text-purple-400" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Project info cards */}
          <div className="grid sm:grid-cols-3 gap-4">
            {selectedProject.data?.mosaicParams && (
              <div className="bg-white rounded-xl border border-cream-200 p-4">
                <p className="text-xs text-gray-400 mb-1">Raster</p>
                <p className="text-lg font-bold text-gray-800">
                  {selectedProject.data.mosaicParams.cols} x {selectedProject.data.mosaicParams.rows}
                </p>
                <p className="text-xs text-gray-400">
                  {selectedProject.data.mosaicParams.cols * selectedProject.data.mosaicParams.rows} Kacheln
                </p>
              </div>
            )}
            {selectedProject.data?.qualityMetrics && (
              <div className="bg-white rounded-xl border border-cream-200 p-4">
                <p className="text-xs text-gray-400 mb-1">Farbqualitaet</p>
                <p className="text-lg font-bold text-gray-800">
                  {selectedProject.data.qualityMetrics.avgDeltaE?.toFixed(1) || '–'} Delta-E
                </p>
                <p className="text-xs text-gray-400">
                  {selectedProject.data.qualityMetrics.matchedTiles || '–'} Tiles zugeordnet
                </p>
              </div>
            )}
            <div className="bg-white rounded-xl border border-cream-200 p-4">
              <p className="text-xs text-gray-400 mb-1">Tile-Quelle</p>
              <p className="text-lg font-bold text-gray-800">
                {SOURCE_MODE_LABELS[selectedProject.tile_source_mode || 'pool']?.label || 'Pool'}
              </p>
              {isOwnMode && (
                <p className="text-xs text-gray-400">{userTiles.length} eigene Fotos</p>
              )}
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
            <p className="text-gray-500">Deine gespeicherten Mosaik-Projekte.</p>
          </div>
          <Link
            to="/studio"
            className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full shadow-md transition-all"
          >
            <Plus className="w-4 h-4" />
            Neues Mosaik
          </Link>
        </div>

        {loading || detailLoading ? (
          <div className="flex justify-center py-16">
            <RefreshCw className="w-6 h-6 text-coral-400 animate-spin" />
          </div>
        ) : projects.length === 0 ? (
          <div className="bg-white rounded-2xl border border-cream-200 p-12 text-center">
            <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-1 font-medium">Noch keine Projekte</p>
            <p className="text-sm text-gray-400 mb-4">Erstelle ein Mosaik im Studio und speichere es.</p>
            <Link
              to="/studio"
              className="inline-flex items-center gap-2 bg-coral-500 hover:bg-coral-600 text-white font-semibold text-sm px-5 py-2.5 rounded-full transition-all"
            >
              Zum Studio
            </Link>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map(project => (
              <div
                key={project.id}
                className="group bg-white rounded-2xl border border-cream-200 hover:border-coral-300 hover:shadow-lg transition-all overflow-hidden cursor-pointer"
                onClick={() => openDetail(project.id)}
              >
                {/* Thumbnail */}
                <div className="aspect-square bg-gray-100 overflow-hidden relative">
                  {project.thumbnail_url ? (
                    <img
                      src={project.thumbnail_url}
                      alt={project.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <FolderOpen className="w-12 h-12 text-gray-300" />
                    </div>
                  )}
                  {/* Source mode tag overlay */}
                  <div className="absolute top-2 left-2">
                    <SourceModeTag mode={project.tile_source_mode} />
                  </div>
                </div>

                {/* Info */}
                <div className="p-4">
                  <h3 className="font-semibold text-gray-900 mb-1 truncate">{project.name}</h3>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {new Date(project.updated_at).toLocaleDateString('de-CH')}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleLoad(project.id) }}
                        className="text-xs text-coral-600 hover:text-coral-700 font-medium px-2 py-1 rounded-lg hover:bg-coral-50 transition-colors"
                      >
                        Studio
                      </button>
                      <button
                        onClick={(e) => handleDelete(project.id, e)}
                        disabled={deleting === project.id}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        {deleting === project.id ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
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
