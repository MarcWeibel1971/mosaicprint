import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Camera, Upload, Users, RefreshCw, Image as ImageIcon, QrCode, X as XIcon } from 'lucide-react'

interface EventData {
  id: number
  slug: string
  name: string
  target_image_url: string | null
  status: string
  max_photos: number
  photo_count: number
}

interface EventPhoto {
  id: number
  thumbnail_url: string
  guest_name: string | null
  avg_l: number
  avg_a: number
  avg_b: number
  created_at: string
}

export default function EventPage() {
  const { slug } = useParams<{ slug: string }>()
  const [event, setEvent] = useState<EventData | null>(null)
  const [photos, setPhotos] = useState<EventPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [guestName, setGuestName] = useState('')
  const [view, setView] = useState<'upload' | 'live'>('upload')
  const [showQr, setShowQr] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchEvent = useCallback(async () => {
    if (!slug) return
    try {
      const res = await fetch(`/api/events/${slug}`)
      const data = await res.json()
      if (data.ok) {
        setEvent(data.event)
      } else {
        setError(data.error || 'Event nicht gefunden')
      }
    } catch {
      setError('Verbindungsfehler')
    } finally {
      setLoading(false)
    }
  }, [slug])

  const fetchPhotos = useCallback(async () => {
    if (!slug) return
    try {
      const res = await fetch(`/api/events/${slug}/photos`)
      const data = await res.json()
      if (data.ok) setPhotos(data.photos)
    } catch { /* ignore */ }
  }, [slug])

  useEffect(() => { fetchEvent() }, [fetchEvent])
  useEffect(() => { fetchPhotos() }, [fetchPhotos])

  // Auto-poll for live view
  useEffect(() => {
    if (view === 'live') {
      pollRef.current = setInterval(() => { fetchPhotos(); fetchEvent() }, 5000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [view, fetchPhotos, fetchEvent])

  // Render live mosaic on canvas
  useEffect(() => {
    if (view !== 'live' || !canvasRef.current || photos.length === 0) return
    const canvas = canvasRef.current
    const cols = Math.ceil(Math.sqrt(photos.length * 1.5))
    const rows = Math.ceil(photos.length / cols)
    const tilePx = 64
    canvas.width = cols * tilePx
    canvas.height = rows * tilePx
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    photos.forEach((photo, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        ctx.drawImage(img, col * tilePx, row * tilePx, tilePx, tilePx)
      }
      img.src = photo.thumbnail_url
    })
  }, [view, photos])

  const handleUpload = async (file: File) => {
    if (!event || uploading) return
    setUploading(true)
    setUploadSuccess(false)
    try {
      // Read file as base64
      const reader = new FileReader()
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.split(',')[1])
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const res = await fetch(`/api/events/${slug}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, guestName: guestName || undefined }),
      })
      const data = await res.json()
      if (data.ok) {
        setUploadSuccess(true)
        setEvent(prev => prev ? { ...prev, photo_count: data.photoCount } : prev)
        fetchPhotos()
        setTimeout(() => setUploadSuccess(false), 3000)
      } else {
        setError(data.error)
        setTimeout(() => setError(null), 3000)
      }
    } catch (e) {
      setError(String(e))
      setTimeout(() => setError(null), 3000)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50">
        <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin" />
      </div>
    )
  }

  if (error && !event) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-orange-50">
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center max-w-sm">
          <div className="text-4xl mb-4">😕</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">Event nicht gefunden</h1>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  if (!event) return null

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50">
      {/* Header */}
      <div className="bg-white/80 backdrop-blur-sm border-b border-indigo-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{event.name}</h1>
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Users className="w-3 h-3" />
              {event.photo_count} / {event.max_photos} Fotos
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!qrDataUrl && slug) {
                  try {
                    const res = await fetch(`/api/events/${slug}/qr-data`)
                    const data = await res.json()
                    if (data.ok) setQrDataUrl(data.qrDataUrl)
                  } catch { /* ignore */ }
                }
                setShowQr(true)
              }}
              className="p-1.5 rounded-lg bg-purple-50 text-purple-600 hover:bg-purple-100 transition-colors"
              title="QR-Code teilen"
            >
              <QrCode className="w-4 h-4" />
            </button>
            <div className="flex rounded-xl overflow-hidden border border-indigo-200 shadow-sm">
              <button
                onClick={() => setView('upload')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === 'upload' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500'
                }`}
              >
                <Camera className="w-3.5 h-3.5 inline mr-1" />Foto
              </button>
              <button
                onClick={() => setView('live')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === 'live' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500'
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5 inline mr-1" />Mosaik
              </button>
            </div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-indigo-100">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
            style={{ width: `${Math.min(100, (event.photo_count / event.max_photos) * 100)}%` }}
          />
        </div>
      </div>

      {/* Upload View */}
      {view === 'upload' && (
        <div className="max-w-lg mx-auto px-4 py-8">
          {/* Target image preview */}
          {event.target_image_url && (
            <div className="mb-6 rounded-2xl overflow-hidden shadow-lg border border-white/50">
              <img src={event.target_image_url} alt="Zielbild" className="w-full object-cover max-h-48" />
            </div>
          )}

          {/* Upload area */}
          <div className="bg-white rounded-2xl shadow-lg border border-indigo-100 p-6 mb-6">
            <h2 className="text-lg font-bold text-gray-800 mb-1 text-center">Dein Foto hinzufuegen</h2>
            <p className="text-sm text-gray-500 text-center mb-6">
              Dein Foto wird Teil des Mosaiks!
            </p>

            {/* Guest name */}
            <input
              type="text"
              placeholder="Dein Name (optional)"
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />

            {/* Upload button */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || event.status !== 'active'}
              className="w-full flex items-center justify-center gap-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 text-white text-base font-bold py-4 rounded-2xl transition-all shadow-lg shadow-indigo-200 active:scale-[0.98]"
            >
              {uploading ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Camera className="w-5 h-5" />
              )}
              {uploading ? 'Wird hochgeladen...' : 'Foto aufnehmen oder waehlen'}
            </button>

            {/* Success message */}
            {uploadSuccess && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-xl p-3 text-center">
                <p className="text-sm font-semibold text-green-700">Dein Foto wurde hinzugefuegt!</p>
                <p className="text-xs text-green-600 mt-0.5">Du kannst weitere Fotos hochladen</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 text-center">
                <p className="text-sm font-semibold text-red-700">{error}</p>
              </div>
            )}
          </div>

          {/* Recent photos grid */}
          {photos.length > 0 && (
            <div className="bg-white rounded-2xl shadow-lg border border-indigo-100 p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
                <Upload className="w-4 h-4 text-indigo-500" />
                Bisherige Fotos ({photos.length})
              </h3>
              <div className="grid grid-cols-4 gap-2">
                {photos.slice(-16).reverse().map(photo => (
                  <div key={photo.id} className="aspect-square rounded-lg overflow-hidden bg-gray-100">
                    <img src={photo.thumbnail_url} alt="" className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Live Mosaic View */}
      {view === 'live' && (
        <div className="px-4 py-6">
          {photos.length === 0 ? (
            <div className="max-w-lg mx-auto bg-white rounded-2xl shadow-lg p-8 text-center">
              <div className="text-4xl mb-4">📸</div>
              <h2 className="text-lg font-bold text-gray-800 mb-2">Noch keine Fotos</h2>
              <p className="text-sm text-gray-500">Wechsle zum Foto-Tab und lade das erste Foto hoch!</p>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto">
              <div className="bg-white rounded-2xl shadow-lg border border-indigo-100 p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-gray-700">
                    Live-Mosaik ({photos.length} Fotos)
                  </h2>
                  <button
                    onClick={fetchPhotos}
                    className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" /> Aktualisieren
                  </button>
                </div>
                <div className="rounded-xl overflow-hidden bg-gray-900">
                  <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: 'auto', display: 'block', imageRendering: 'auto' }}
                  />
                </div>
              </div>
              {/* Photo contributors */}
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-4 border border-indigo-100">
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Beitragende</h3>
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set(photos.filter(p => p.guest_name).map(p => p.guest_name))].map(name => (
                    <span key={name} className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                      {name}
                    </span>
                  ))}
                  {photos.filter(p => !p.guest_name).length > 0 && (
                    <span className="text-xs bg-gray-50 text-gray-500 px-2 py-0.5 rounded-full">
                      +{photos.filter(p => !p.guest_name).length} anonym
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* QR Code Modal */}
      {showQr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowQr(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-xs mx-4 text-center shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold text-gray-900">QR-Code teilen</h3>
              <button onClick={() => setShowQr(false)} className="text-gray-400 hover:text-gray-600">
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">Andere Gaeste koennen den Code scannen, um Fotos beizusteuern.</p>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR Code" className="w-48 h-48 mx-auto mb-3 rounded-lg" />
            ) : (
              <div className="w-48 h-48 mx-auto mb-3 bg-gray-100 rounded-lg flex items-center justify-center">
                <RefreshCw className="w-6 h-6 text-gray-300 animate-spin" />
              </div>
            )}
            <p className="text-[10px] text-gray-400 break-all">{window.location.href}</p>
          </div>
        </div>
      )}
    </div>
  )
}
