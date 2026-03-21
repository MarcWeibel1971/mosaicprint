import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, Users, Camera, RefreshCw, QrCode } from 'lucide-react'

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
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/events')
      .then(r => r.json())
      .then(data => {
        if (data.ok) setEvents(data.events.filter((e: EventItem) => e.status === 'active'))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

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

      {/* Active events */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <h2 className="font-serif text-2xl text-gray-900 mb-6">Aktive Events</h2>

        {loading ? (
          <div className="flex justify-center py-12">
            <RefreshCw className="w-6 h-6 text-coral-400 animate-spin" />
          </div>
        ) : events.length === 0 ? (
          <div className="bg-white rounded-2xl border border-cream-200 p-12 text-center">
            <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 mb-1">Noch keine aktiven Events</p>
            <p className="text-sm text-gray-400">Events koennen im Admin-Bereich erstellt werden.</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {events.map(ev => (
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
    </div>
  )
}
