import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, Users, Camera, RefreshCw, QrCode, Plus, Download } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

export default function Events() {
  const { user, authHeaders } = useAuth()

  // Create event state
  const [eventName, setEventName] = useState('')
  const [eventMaxPhotos, setEventMaxPhotos] = useState(500)
  const [eventCreating, setEventCreating] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [createdEvent, setCreatedEvent] = useState<{ slug: string; name: string; qrDataUrl?: string; eventUrl?: string } | null>(null)

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
        setMessage({ text: `Event "${data.event.name}" erstellt! Du findest es jetzt unter Projekte.`, type: 'success' })
        setEventName('')
        // Fetch QR code for the newly created event
        try {
          const qrRes = await fetch(`/api/events/${data.event.slug}/qr-data`)
          const qrData = await qrRes.json()
          if (qrData.ok) {
            setCreatedEvent({ slug: data.event.slug, name: data.event.name, qrDataUrl: qrData.qrDataUrl, eventUrl: qrData.eventUrl })
          } else {
            setCreatedEvent({ slug: data.event.slug, name: data.event.name })
          }
        } catch {
          setCreatedEvent({ slug: data.event.slug, name: data.event.name })
        }
      } else {
        setMessage({ text: `Fehler: ${data.error}`, type: 'error' })
      }
    } catch (e) {
      setMessage({ text: `Fehler: ${String(e)}`, type: 'error' })
    } finally {
      setEventCreating(false)
    }
  }

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
            Lade Gaeste ein, Fotos beizusteuern — jedes Bild wird Teil eines einzigartigen Mosaiks.
            Perfekt fuer Hochzeiten, Firmenevents und Feiern.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-6 pb-12">
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: QrCode, title: 'QR-Code teilen', desc: 'Gaeste scannen den Code mit dem Handy' },
            { icon: Camera, title: 'Fotos hochladen', desc: 'Jeder Gast laedt ein oder mehrere Fotos hoch' },
            { icon: Users, title: 'Mosaik waechst', desc: 'Das Mosaik wird live aus allen Fotos zusammengesetzt' },
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

      {/* Create Event */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        {user ? (
          <div className="bg-white rounded-2xl p-6 border border-coral-200 shadow-sm">
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
            <p className="text-xs text-gray-400 mt-3">
              Nach dem Erstellen findest du dein Event unter <Link to="/projekte" className="text-coral-500 hover:underline">Projekte</Link>, wo du es verwalten kannst.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-cream-200 p-12 text-center">
            <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-1">Erstelle dein eigenes Mosaik-Event</p>
            <p className="text-sm text-gray-400">
              <Link to="/login" className="text-coral-500 hover:underline">Einloggen</Link>, um ein Event zu erstellen.
            </p>
          </div>
        )}

        {/* QR Code for just-created event */}
        {createdEvent && createdEvent.qrDataUrl && (
          <div className="mt-6 bg-white rounded-2xl p-8 border border-green-200 shadow-sm text-center">
            <h3 className="font-bold text-lg text-gray-900 mb-2">Event "{createdEvent.name}" erstellt!</h3>
            <p className="text-sm text-gray-500 mb-4">Teile diesen QR-Code mit deinen Gaesten.</p>
            <img src={createdEvent.qrDataUrl} alt="QR Code" className="w-64 h-64 mx-auto mb-4 rounded-xl border border-gray-200" />
            {createdEvent.eventUrl && (
              <p className="text-xs text-gray-400 break-all mb-4">{createdEvent.eventUrl}</p>
            )}
            <div className="flex gap-2 justify-center">
              <a
                href={`/api/events/${createdEvent.slug}/qr?format=png`}
                download={`qr-${createdEvent.slug}.png`}
                className="flex items-center gap-1.5 bg-coral-500 hover:bg-coral-600 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                PNG herunterladen
              </a>
              <button
                onClick={() => {
                  if (createdEvent.eventUrl) {
                    navigator.clipboard.writeText(createdEvent.eventUrl)
                    setMessage({ text: 'Link kopiert!', type: 'success' })
                  }
                }}
                className="text-xs text-gray-500 hover:text-gray-700 px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Link kopieren
              </button>
              <Link
                to="/projekte"
                className="text-xs text-coral-600 hover:text-coral-700 font-medium px-4 py-2 rounded-lg border border-coral-200 hover:bg-coral-50 transition-colors"
              >
                Zu Projekten
              </Link>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
