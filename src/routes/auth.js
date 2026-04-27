import express from 'express'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../db/index.js'

const router = express.Router()

// ─── Step 1: Redirect to Discord ─────────────────────────────
router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  })
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`)
})

// ─── Step 2: Discord callback ─────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code } = req.query
  if (!code) return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`)

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    const { access_token } = tokenRes.data

    // Get Discord user info
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    })
    const discordUser = userRes.data

    // Find or create profile
    let profile = await queryOne('SELECT * FROM profiles WHERE discord_id = ?', [discordUser.id])

    if (!profile) {
      const newId  = uuidv4()
      const apiKey = uuidv4().replace(/-/g,'') + uuidv4().replace(/-/g,'')
      const avatar = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null

      await query(
        `INSERT INTO profiles (id, discord_id, discord_username, avatar_url, api_key)
         VALUES (?, ?, ?, ?, ?)`,
        [newId, discordUser.id, discordUser.username, avatar, apiKey]
      )
      profile = await queryOne('SELECT * FROM profiles WHERE id = ?', [newId])
    } else {
      // Update username/avatar
      const avatar = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : profile.avatar_url
      await query(
        'UPDATE profiles SET discord_username = ?, avatar_url = ?, updated_at = NOW() WHERE id = ?',
        [discordUser.username, avatar, profile.id]
      )
      profile.discord_username = discordUser.username
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: profile.id, discordId: profile.discord_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )

    // Store session
    const sessionId  = uuidv4()
    const expiresAt  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await query(
      'INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)',
      [sessionId, profile.id, token, expiresAt]
    )

    // Redirect to frontend with token
    res.redirect(`${process.env.FRONTEND_URL}/auth?token=${token}`)

  } catch (err) {
    console.error('OAuth error:', err.message)
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed`)
  }
})

// ─── GET /auth/me ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })

  try {
    const token   = header.slice(7)
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const profile = await queryOne('SELECT * FROM profiles WHERE id = ?', [payload.userId])
    if (!profile) return res.status(404).json({ error: 'Not found' })
    res.json(profile)
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

// ─── POST /auth/logout ────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7)
    await query('DELETE FROM auth_sessions WHERE token = ?', [token]).catch(() => {})
  }
  res.json({ success: true })
})

export default router
