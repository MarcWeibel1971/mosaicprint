import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Trash2, RefreshCw, Calendar, Plus } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

interface Project {
  id: number
  name: string
  thumbnail_url: string | null
  created_at: string
  updated_at: string
}

export default function Projects() {
  const { user, authHeaders } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)

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

  const handleDelete = async (id: number) => {
    if (!confirm('Projekt wirklich loeschen?')) return
    setDeleting(id)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: authHeaders() })
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch { /* ignore */ }
    finally { setDeleting(null) }
  }

  const handleLoad = (id: number) => {
    navigate(`/studio?project=${id}`)
  }

  if (!user) return null

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

        {loading ? (
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
                className="group bg-white rounded-2xl border border-cream-200 hover:border-coral-300 hover:shadow-lg transition-all overflow-hidden"
              >
                {/* Thumbnail */}
                <button onClick={() => handleLoad(project.id)} className="w-full text-left">
                  <div className="aspect-square bg-gray-100 overflow-hidden">
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
                  </div>
                </button>

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
                        onClick={() => handleLoad(project.id)}
                        className="text-xs text-coral-600 hover:text-coral-700 font-medium px-2 py-1 rounded-lg hover:bg-coral-50 transition-colors"
                      >
                        Laden
                      </button>
                      <button
                        onClick={() => handleDelete(project.id)}
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
