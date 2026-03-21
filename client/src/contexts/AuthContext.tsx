import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

interface User {
  id: number
  email: string
  displayName: string | null
}

interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  register: (email: string, password: string, displayName: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
  authHeaders: () => Record<string, string>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('mosaicprint_token'))
  const [loading, setLoading] = useState(!!localStorage.getItem('mosaicprint_token'))

  // Validate token on mount
  useEffect(() => {
    if (!token) { setLoading(false); return }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setUser(data.user)
        } else {
          localStorage.removeItem('mosaicprint_token')
          setToken(null)
        }
      })
      .catch(() => {
        localStorage.removeItem('mosaicprint_token')
        setToken(null)
      })
      .finally(() => setLoading(false))
  }, [token])

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (data.ok) {
        localStorage.setItem('mosaicprint_token', data.token)
        setToken(data.token)
        setUser(data.user)
        return { ok: true }
      }
      return { ok: false, error: data.error }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, [])

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      })
      const data = await res.json()
      if (data.ok) {
        localStorage.setItem('mosaicprint_token', data.token)
        setToken(data.token)
        setUser(data.user)
        return { ok: true }
      }
      return { ok: false, error: data.error }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('mosaicprint_token')
    setToken(null)
    setUser(null)
  }, [])

  const authHeaders = useCallback((): Record<string, string> => {
    return token ? { Authorization: `Bearer ${token}` } : {}
  }, [token])

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, authHeaders }}>
      {children}
    </AuthContext.Provider>
  )
}
