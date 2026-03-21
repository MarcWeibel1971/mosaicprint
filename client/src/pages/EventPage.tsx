import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Camera, Users, RefreshCw, Image as ImageIcon, QrCode, X as XIcon, Mail, CheckCircle } from 'lucide-react'

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

  // Mosaic opt-in state
  const [wantsMosaic, setWantsMosaic] = useState(false)
  const [participantName, setParticipantName] = useState('')
  const [participantEmail, setParticipantEmail] = useState('')
  const [registering, setRegistering] = useState(false)
  const [registered, setRegistered] = useState(false)

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
        setTimeout(() => setUploadSuccess(false), 5000)
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

  const handleRegister = async () => {
    if (!participantName.trim() || !participantEmail.trim() || registering) return
    setRegistering(true)
    try {
      const res = await fetch(`/api/events/${slug}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: participantName.trim(), email: participantEmail.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setRegistered(true)
      } else {
        setError(data.error)
        setTimeout(() => setError(null), 3000)
      }
    } catch (e) {
      setError(String(e))
      setTimeout(() => setError(null), 3000)
    } finally {
      setRegistering(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-coral-50 to-cream-50">
        <RefreshCw className="w-8 h-8 text-coral-500 animate-spin" />
      </div>
    )
  }

  if (error && !event) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-orange-50">
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center max-w-sm">
          <h1 className="text-xl font-bold text-gray-800 mb-2">Event nicht gefunden</h1>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  if (!event) return null

  return (
    <div className="min-h-screen bg-gradient-to-br from-coral-50 via-cream-50 to-white">
      {/* Header */}
      <div className="bg-white/80 backdrop-blur-sm border-b border-coral-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{event.name}</h1>
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Camera className="w-3 h-3" />
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
              className="p-1.5 rounded-lg bg-coral-50 text-coral-600 hover:bg-coral-100 transition-colors"
              title="QR-Code teilen"
            >
              <QrCode className="w-4 h-4" />
            </button>
            <div className="flex rounded-xl overflow-hidden border border-coral-200 shadow-sm">
              <button
                onClick={() => setView('upload')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === 'upload' ? 'bg-coral-500 text-white' : 'bg-white text-gray-500'
                }`}
              >
                <Camera className="w-3.5 h-3.5 inline mr-1" />Foto
              </button>
              <button
                onClick={() => setView('live')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === 'live' ? 'bg-coral-500 text-white' : 'bg-white text-gray-500'
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5 inline mr-1" />Mosaik
              </button>
            </div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-coral-100">
          <div
            className="h-full bg-gradient-to-r from-coral-400 to-coral-500 transition-all duration-500"
            style={{ width: `${Math.min(100, (event.photo_count / event.max_photos) * 100)}%` }}
          />
        </div>
      </div>

      {/* Upload View */}
      {view === 'upload' && (
        <div className="max-w-lg mx-auto px-4 py-8">
          {/* Simple instructions */}
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-gray-800 mb-1">Willkommen!</h2>
            <p className="text-sm text-gray-500">
              Lade ein Foto hoch — es wird Teil eines gemeinsamen Mosaiks.
            </p>
          </div>

          {/* Target image preview */}
          {event.target_image_url && (
            <div className="mb-6 rounded-2xl overflow-hidden shadow-lg border border-white/50">
              <img src={event.target_image_url} alt="Zielbild" className="w-full object-cover max-h-48" />
            </div>
          )}

          {/* Upload area */}
          <div className="bg-white rounded-2xl shadow-lg border border-coral-100 p-6 mb-6">
            {/* Guest name */}
            <input
              type="text"
              placeholder="Dein Name (optional)"
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-coral-300"
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
              className="w-full flex items-center justify-center gap-3 bg-gradient-to-r from-coral-500 to-coral-600 hover:from-coral-600 hover:to-coral-700 disabled:opacity-50 text-white text-base font-bold py-4 rounded-2xl transition-all shadow-lg shadow-coral-200 active:scale-[0.98]"
            >
              {uploading ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Camera className="w-5 h-5" />
              )}
              {uploading ? 'Wird hochgeladen...' : 'Foto aufnehmen oder wählen'}
            </button>

            {/* Success message */}
            {uploadSuccess && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-xl p-3 text-center">
                <p className="text-sm font-semibold text-green-700">Dein Foto wurde hinzugefügt!</p>
                <p className="text-xs text-green-600 mt-0.5">Du kannst weitere Fotos hochladen.</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 text-center">
                <p className="text-sm font-semibold text-red-700">{error}</p>
              </div>
            )}
          </div>

          {/* Mosaic opt-in */}
          <div className="bg-white rounded-2xl shadow-lg border border-coral-100 p-6 mb-6">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={wantsMosaic}
                onChange={e => setWantsMosaic(e.target.checked)}
                disabled={registered}
                className="mt-0.5 w-5 h-5 rounded border-gray-300 text-coral-500 focus:ring-coral-400 accent-coral-500"
              />
              <div>
                <span className="text-sm font-semibold text-gray-800">Fertiges Mosaik erhalten</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Ich möchte das fertige Mosaik per E-Mail zugestellt bekommen.
                </p>
              </div>
            </label>

            {wantsMosaic && !registered && (
              <div className="mt-4 space-y-3">
                <input
                  type="text"
                  placeholder="Dein Name"
                  value={participantName}
                  onChange={e => setParticipantName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-coral-300"
                />
                <input
                  type="email"
                  placeholder="Deine E-Mail-Adresse"
                  value={participantEmail}
                  onChange={e => setParticipantEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRegister() }}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-coral-300"
                />
                <button
                  onClick={handleRegister}
                  disabled={registering || !participantName.trim() || !participantEmail.trim()}
                  className="w-full flex items-center justify-center gap-2 bg-coral-50 hover:bg-coral-100 disabled:opacity-50 text-coral-700 text-sm font-semibold py-2.5 rounded-xl border border-coral-200 transition-colors"
                >
                  {registering ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  Registrieren
                </button>
              </div>
            )}

            {registered && (
              <div className="mt-4 flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl p-3">
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                <p className="text-sm text-green-700">
                  Du erhältst das fertige Mosaik an <strong>{participantEmail}</strong>.
                </p>
              </div>
            )}
          </div>

          {/* Recent photos grid */}
          {photos.length > 0 && (
            <div className="bg-white rounded-2xl shadow-lg border border-coral-100 p-4">
              <h3 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-coral-500" />
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
              <Camera className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <h2 className="text-lg font-bold text-gray-800 mb-2">Noch keine Fotos</h2>
              <p className="text-sm text-gray-500">Wechsle zum Foto-Tab und lade das erste Foto hoch!</p>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto">
              <div className="bg-white rounded-2xl shadow-lg border border-coral-100 p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-gray-700">
                    Live-Mosaik ({photos.length} Fotos)
                  </h2>
                  <button
                    onClick={fetchPhotos}
                    className="text-xs text-coral-600 hover:text-coral-700 font-semibold flex items-center gap-1"
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
              <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-4 border border-coral-100">
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Beitragende</h3>
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set(photos.filter(p => p.guest_name).map(p => p.guest_name))].map(name => (
                    <span key={name} className="text-xs bg-coral-50 text-coral-700 px-2 py-0.5 rounded-full font-medium">
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
            <p className="text-xs text-gray-500 mb-4">Andere Gäste können den Code scannen, um Fotos beizusteuern.</p>
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
