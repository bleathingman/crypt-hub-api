import express from 'express'
import { query, queryOne } from '../db/index.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

router.get('/avatar/:robloxId', async (req, res) => {
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.robloxId}&size=48x48&format=Png`
  const data = await fetch(url).then(r => r.json())
  res.json(data)
})

router.use(authMiddleware)

// ─── GET /data/accounts ───────────────────────────────────────
router.get('/accounts', async (req, res) => {
  const rows = await query(
    `SELECT id, roblox_id, name, username, level, vel, exp,
     floor, weapon, armor, max_hp, skills,
     roblox_avatar_url, is_online, last_sync,
     total_kills, total_damage, total_vel_earned,
     inventory_count, inventory_hash,
     current_job_id, executor, uptime, version,
     eggs_found, egg_hunt_runs, accessory_chance,
     pity_data, floor_pity, farm_data, extra_stats,
     session_start, created_at
     FROM accounts WHERE user_id = ?
     ORDER BY last_sync DESC`,
    [req.user.id]
  )
  // Parse JSON fields
  const parsed = rows.map(r => ({
    ...r,
    skills:      tryParse(r.skills, []),
    eggs_found:  tryParse(r.eggs_found, []),
    pity_data:   tryParse(r.pity_data, null),
    floor_pity:  tryParse(r.floor_pity, null),
    farm_data:   tryParse(r.farm_data, null),
    extra_stats: tryParse(r.extra_stats, null),
    is_online:   !!r.is_online,
  }))
  res.json(parsed)
})

// ─── DELETE /data/accounts/:id ────────────────────────────────
router.delete('/accounts/:id', async (req, res) => {
  await query('DELETE FROM accounts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  res.json({ success: true })
})

// ─── GET /data/inventory/:accountId ──────────────────────────
router.get('/inventory/:accountId', async (req, res) => {
  const inv = await queryOne(
    'SELECT items, item_count, updated_at FROM inventory WHERE account_id = ?',
    [req.params.accountId]
  )
  if (!inv) return res.json({ items: [], item_count: 0 })
  res.json({ ...inv, items: tryParse(inv.items, []) })
})

// ─── GET /data/drops ─────────────────────────────────────────
router.get('/drops', async (req, res) => {
  const rows = await query(
    `SELECT * FROM drop_history WHERE user_id = ?
     ORDER BY dropped_at DESC LIMIT 200`,
    [req.user.id]
  )
  res.json(rows)
})

// ─── GET /data/sessions ───────────────────────────────────────
router.get('/sessions', async (req, res) => {
  const rows = await query(
    `SELECT * FROM sessions WHERE user_id = ?
     ORDER BY started_at DESC LIMIT 100`,
    [req.user.id]
  )
  res.json(rows)
})

// ─── GET /data/profile ────────────────────────────────────────
router.get('/profile', async (req, res) => {
  res.json(req.user)
})

// ─── PATCH /data/profile ─────────────────────────────────────
router.patch('/profile', async (req, res) => {
  const { webhook_url } = req.body
  if (webhook_url !== undefined) {
    await query('UPDATE profiles SET webhook_url = ?, updated_at = NOW() WHERE id = ?',
      [webhook_url, req.user.id])
  }
  const updated = await queryOne('SELECT * FROM profiles WHERE id = ?', [req.user.id])
  res.json(updated)
})

function tryParse(val, fallback) {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

export default router
