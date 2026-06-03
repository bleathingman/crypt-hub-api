import jwt from 'jsonwebtoken'
import { queryOne } from '../db/index.js'

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)

    // Check token not revoked
    const session = await queryOne(
      'SELECT * FROM auth_sessions WHERE token = ? AND expires_at > NOW()',
      [token]
    )
    if (!session) return res.status(401).json({ error: 'Token expired or revoked' })

    const profile = await queryOne('SELECT * FROM profiles WHERE id = ?', [payload.userId])
    if (!profile) return res.status(401).json({ error: 'User not found' })

    req.user = profile
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export async function apiKeyMiddleware(req, res, next) {
  const apiKey = req.body?.api_key || req.headers['x-api-key'] || req.query?.api_key
  if (!apiKey) return res.status(401).json({ error: 'Missing api_key' })

  const profile = await queryOne('SELECT * FROM profiles WHERE api_key = ?', [apiKey])
  if (!profile) return res.status(401).json({ error: 'Invalid API key' })

  req.user = profile
  next()
}
