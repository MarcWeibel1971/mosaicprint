import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, Users, Camera, RefreshCw, QrCode, Plus, Trash2, Link as LinkIcon, Image as ImageIcon, Download } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

interface EventItem {
  id: number
  slug: string
  name: string
  status: string
  max_photos: number
  photo_count: number
  target_image_url: string | null
  created_at: string
}

export default function Events() {
  const { user, authHeaders } = useAuth()
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)

  // Management state (logged-in users only)
  const [eventName, setEventName] = useState('')
  const [eventMaxPhotos, setEventMaxPhotos] = useState(500)
  const [eventCreating, setEventCreating] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [qrEvent, setQrEvent] = useState<{ slug: string; qrDataUrl: string; eventUrl: string } | null>(null)

  const fetchEvents = useCallback(() => {
    fetch('/api/events')
      .then(r => r.json())
      .then(data => {
        if (data.ok) setEvents(data.events ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Clear message after 4 seconds
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  const createEvent = async () => {
    if (!eventName.trim() || eventCreating) return
    setEventCreating(true)
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name: eventName.trim(), maxPhotos: eventMaxPhotos }),
      })
      const data = await res.json()
      if (data.ok) {
        setEventName('')
        fetchEvents()
        setMessage({ text: `Event "${data.event.name}" erstellt!`, type: 'success' })
      } else {
        setMessage({ text: `Fehler: ${data.error}`, type: 'error' })
      }
    } catch (e) {
      setMessage({ text: `Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setEventCreating(false)
    }
  }

  const deleteEvent = async (slug: string, name: string) => {
    if (!confirm(`Event "${name}" wirklich löschen? Alle Gästefotos werden entfernt.`)) return
    try {
      await fetch(`/api/events/${slug}`, { method: 'DELETE', headers: authHeaders() })
      fetchEvents()
      setMessage({ text: `Event "${name}" gelöscht`, type: 'success' })
    } catch { /* ignore */ }
  }

  const showQrCode = async (slug: string) => {
    try {
      const res = await fetch(`/api/events/${slug}/qr-data`)
      const data = await res.json()
      if (data.ok) {
        setQrEvent({ slug, qrDataUrl: data.qrDataUrl, eventUrl: data.eventUrl })
      }
    } catch { /* ignore */ }
  }

  const activeEvents = events.filter(e => e.status === 'active')

  return (
    <div className="min-h-screen bg-gradient-to-b from-cream-50 to-white">
      {/* Hero */}
      <section className="py-16 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-coral-50 text-coral-600 text-xs font-semibold px-4 py-1.5 rounded-full mb-6">
            <Camera className="w-3.5 h-3.5" />
            Live Events
          </div>
          <h1 className="font-serif text-4xl md:text-5xl text-gray-900 mb-4">
            Gemeinsam ein Mosaik erschaffen
          </h1>
          <p className="text-lg text-gray-500 max-w-xl mx-auto">
            Lade Gäste ein, Fotos beizusteuern — jedes Bild wird Teil eines einzigartigen Mosaiks.
            Perfekt für Hochzeiten, Firmenevents und Feiern.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-6 pb-12">
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: QrCode, title: 'QR-Code teilen', desc: 'Gäste scannen den Code mit dem Handy' },
            { icon: Camera, title: 'Fotos hochladen', desc: 'Jeder Gast lädt ein oder mehrere Fotos hoch' },
            { icon: Users, title: 'Mosaik wächst', desc: 'Das Mosaik wird live aus allen Fotos zusammengesetzt' },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="bg-white rounded-2xl border border-cream-200 p-6 text-center">
              <div className="w-12 h-12 mx-auto mb-4 bg-coral-50 rounded-xl flex items-center justify-center">
                <Icon className="w-6 h-6 text-coral-500" />
              </div>
              <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
              <p className="text-sm text-gray-500">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Message toast */}
      {message && (
        <div className="max-w-4xl mx-auto px-6 mb-4">
          <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
            message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {message.text}
          </div>
        </div>
      )}

      {/* Event Management (logged-in users only) */}
      {user && (
        <section className="max-w-4xl mx-auto px-6 pb-8">
          <h2 className="font-serif text-2xl text-gray-900 mb-4">Meine Events</h2>

          {/* Create Event */}
          <div className="bg-white rounded-2xl p-6 border border-coral-200 shadow-sm mb-6">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-4">
              <Plus className="w-5 h-5 text-coral-500" />
              Neues Event erstellen
            </h3>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Event-Name (z.B. Hochzeit Meier)"
                value={eventName}
                onChange={e => setEventName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createEvent() }}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-coral-300"
              />
              <input
                type="number"
                placeholder="Max Fotos"
                value={eventMaxPhotos}
                onChange={e => setEventMaxPhotos(Number(e.target.value))}
                className="w-32 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-coral-300"
              />
              <button
                onClick={createEvent}
                disabled={eventCreating || !eventName.trim()}
                className="flex items-center justify-center gap-2 bg-coral-500 hover:bg-coral-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
              >
                {eventCreating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Erstellen
              </button>
            </div>
          </div>

          {/* My Events List */}
          {events.length > 0 && (
            <div className="space-y-3 mb-8">
              {events.map(event => (
                <div key={event.id} className="bg-white rounded-2xl p-5 border border-gray-200 shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-coral-50 flex items-center justify-center text-coral-500">
                      <Camera className="w-6 h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-gray-900">{event.name}</h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {event.photo_count} / {event.max_photos} Fotos
                        {' | '}
                        <span className={event.status === 'active' ? 'text-green-600' : 'text-gray-400'}>
                          {event.status === 'active' ? 'Aktiv' : 'Beendet'}
                        </span>
                        {' | '}
                        {new Date(event.created_at).toLocaleDateString('de-CH')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <button
                      onClick={() => showQrCode(event.slug)}
                      className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      QR-Code
                    </button>
                    <button
                      onClick={() => {
                        const url = `${window.location.origin}/event/${event.slug}`
                        navigator.clipboard.writeText(url)
                        setMessage({ text: `Link kopiert: ${url}`, type: 'success' })
                      }}
                      className="flex items-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                    >
                      <LinkIcon className="w-3.5 h-3.5" />
                      Link kopieren
                    </button>
                    <a
                      href={`/event/${event.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                    >
                      <ImageIcon className="w-3.5 h-3.5" />
                      Öffnen
                    </a>
                    <button
                      onClick={() => deleteEvent(event.slug, event.name)}
                      className="flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Löschen
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Active events (public) */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <h2 className="font-serif text-2xl text-gray-900 mb-6">Aktive Events</h2>

        {loading ? (
          <div className="flex justify-center py-12">
            <RefreshCw className="w-6 h-6 text-coral-400 animate-spin" />
          </div>
        ) : activeEvents.length === 0 ? (
          <div className="bg-white rounded-2xl border border-cream-200 p-12 text-center">
            <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-1">Noch keine aktiven Events</p>
            {!user && (
              <p className="text-sm text-gray-400">
                <Link to="/login" className="text-coral-500 hover:underline">Einloggen</Link>, um ein Event zu erstellen.
              </p>
            )}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {activeEvents.map(ev => (
              <Link
                key={ev.id}
                to={`/event/${ev.slug}`}
                className="group bg-white rounded-2xl border border-cream-200 hover:border-coral-300 hover:shadow-lg transition-all overflow-hidden"
              >
                {ev.target_image_url && (
                  <div className="h-36 overflow-hidden bg-gray-100">
                    <img
                      src={ev.target_image_url}
                      alt={ev.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  </div>
                )}
                <div className="p-5">
                  <h3 className="font-semibold text-gray-900 group-hover:text-coral-600 transition-colors mb-1">
                    {ev.name}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <Camera className="w-3.5 h-3.5" />
                      {ev.photo_count} / {ev.max_photos}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      {new Date(ev.created_at).toLocaleDateString('de-CH')}
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="mt-3 h-1.5 bg-cream-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-coral-400 to-coral-500 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (ev.photo_count / ev.max_photos) * 100)}%` }}
                    />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* QR Code Modal */}
      {qrEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setQrEvent(null)}>
          <div className="bg-white rounded-2xl p-8 max-w-sm mx-4 text-center shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg text-gray-900 mb-2">QR-Code</h3>
            <p className="text-sm text-gray-500 mb-4">Gäste scannen diesen Code, um Fotos hochzuladen.</p>
            <img src={qrEvent.qrDataUrl} alt="QR Code" className="w-64 h-64 mx-auto mb-4 rounded-xl border border-gray-200" />
            <p className="text-xs text-gray-400 break-all mb-4">{qrEvent.eventUrl}</p>
            <div className="flex gap-2 justify-center">
              <a
                href={`/api/events/${qrEvent.slug}/qr?format=png`}
                download={`qr-${qrEvent.slug}.png`}
                className="flex items-center gap-1.5 bg-coral-500 hover:bg-coral-600 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                PNG herunterladen
              </a>
              <button
                onClick={() => setQrEvent(null)}
                className="text-xs text-gray-500 hover:text-gray-700 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Schliessen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
