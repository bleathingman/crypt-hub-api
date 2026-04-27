import express from 'express'
import axios from 'axios'
import { query, queryOne } from '../db/index.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

router.post('/', authMiddleware, async (req, res) => {
  const { junkie_key } = req.body
  if (!junkie_key) return res.status(400).json({ error: 'Missing junkie_key' })

  try {
    // Verify with Junkie API
    const response = await axios.post('https://api.junkie.lol/v1/verify', {
      key: junkie_key
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    })

    const data = response.data
    if (!data.valid) {
      return res.status(400).json({ error: 'Invalid key', message: 'This key is not valid.' })
    }
    if (data.type !== 'premium') {
      return res.status(400).json({ error: 'Not premium', message: 'Only premium keys can activate CrypT Hub.' })
    }

    const expiresAt = data.expires_at || null

    await query(
      `UPDATE profiles
       SET is_premium = 1, junkie_key_id = ?, key_expires_at = ?, updated_at = NOW()
       WHERE id = ?`,
      [data.key_id || junkie_key, expiresAt, req.user.id]
    )

    return res.json({ success: true, expires_at: expiresAt, key_id: data.key_id })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(400).json({ error: 'Key not found', message: 'This key does not exist.' })
    }
    console.error('Junkie verify error:', err.message)
    return res.status(500).json({ error: 'Verification service unavailable' })
  }
})

export default router
