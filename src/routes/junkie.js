import express from 'express'
import { query } from '../db/index.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()
const JUNKIE_API = 'https://api.jnkie.com/api/v2'

router.post('/', authMiddleware, async (req, res) => {
  const { junkie_key } = req.body
  if (!junkie_key) return res.status(400).json({ error: 'Missing junkie_key' })

  try {
    const junkieRes = await fetch(`${JUNKIE_API}/keys?key=${encodeURIComponent(junkie_key)}&limit=1`, {
      headers: { 'Authorization': `Bearer ${process.env.JUNKIE_API_KEY}` }
    })

    if (!junkieRes.ok) {
      return res.status(502).json({ error: 'junkie_api_error', message: 'Could not verify key.' })
    }

    const junkieData = await junkieRes.json()
    const keys = junkieData.keys || []

    if (keys.length === 0) return res.status(404).json({ error: 'key_not_found', message: 'Key not found.' })

    const keyInfo = keys[0]
    if (!keyInfo.is_premium)    return res.status(403).json({ error: 'premium_required', message: 'Not a premium key.' })
    if (keyInfo.is_invalidated) return res.status(403).json({ error: 'key_invalidated',  message: 'Key invalidated.' })
    if (keyInfo.expires_at && new Date(keyInfo.expires_at) < new Date()) {
      return res.status(403).json({ error: 'key_expired', message: 'Key expired.' })
    }

    await query(
      `UPDATE profiles SET is_premium = 1, junkie_key_id = ?, junkie_key_hash = ?, key_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [keyInfo.id, junkie_key.replace(/-/g, '').substring(0, 32), keyInfo.expires_at || null, req.user.id]
    )

    return res.json({ success: true, expires_at: keyInfo.expires_at || null, key_id: keyInfo.id })

  } catch (err) {
    console.error('Junkie error:', err.message)
    return res.status(500).json({ error: 'Verification service unavailable' })
  }
})

export default router