import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne } from '../db/index.js'
import { apiKeyMiddleware } from '../middleware/auth.js'

const router = express.Router()

function hashInventory(inventory) {
  if (!Array.isArray(inventory) || !inventory.length) return '0_empty'
  const count = inventory.length
  const first = inventory[0]?.name || ''
  const last  = inventory[inventory.length - 1]?.name || ''
  const upgradeSum = inventory.reduce((s, i) => s + (i.upgrade || 0), 0)
  return `${count}_${first}_${last}_${upgradeSum}`
}

router.post('/', apiKeyMiddleware, async (req, res) => {
  try {
    const { roblox_id, action, data } = req.body
    const profile = req.user

    if (!roblox_id) return res.status(400).json({ error: 'Missing roblox_id' })

    // Auto-offline stale accounts
    await query(
      `UPDATE accounts SET is_online = 0
       WHERE user_id = ? AND is_online = 1
       AND last_sync < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
      [profile.id]
    )

    // Close stale sessions
    const staleAccs = await query(
      'SELECT id FROM accounts WHERE user_id = ? AND is_online = 0',
      [profile.id]
    )
    for (const acc of staleAccs) {
      await query(
        `UPDATE sessions SET ended_at = NOW()
         WHERE account_id = ? AND ended_at IS NULL`,
        [acc.id]
      )
    }

    // Find account
    let account = await queryOne(
      'SELECT id, inventory_hash FROM accounts WHERE user_id = ? AND roblox_id = ?',
      [profile.id, roblox_id.toString()]
    )

    // ── ACTION: sync ────────────────────────────────────────────
    if (!action || action === 'sync') {
      const eggData = (req.body.egg_data && typeof req.body.egg_data === 'object')
        ? req.body.egg_data
        : (data?.egg_data && typeof data.egg_data === 'object') ? data.egg_data : null

      const incomingInventory = data?.inventory || []
      const incomingHash      = hashInventory(incomingInventory)
      const inventoryChanged  = !account || account.inventory_hash !== incomingHash

      const rawCollected = eggData ? (eggData.collected || []) : (data?.eggs_found || [])
      const eggsFound    = JSON.stringify(rawCollected.filter(e => e && e !== '???' && e !== ''))
      const eggRuns      = eggData ? Math.floor(eggData.hunts_completed || 0) : Math.floor(data?.egg_hunt_runs || 0)
      const accChance    = eggData ? Math.floor(eggData.accessory_chance || 0) : Math.floor(data?.accessory_chance || 0)

      const fields = {
        user_id:          profile.id,
        roblox_id:        roblox_id.toString(),
        username:         data?.username || '',
        name:             data?.name || '',
        level:            Math.floor(data?.level || 0),
        vel:              Math.floor(data?.vel || 0),
        exp:              Math.floor(data?.exp || 0),
        floor:            data?.floor || 'Unknown',
        weapon:           data?.weapon || '',
        armor:            data?.armor || '',
        max_hp:           Math.floor(data?.max_hp || 0),
        skills:           JSON.stringify(data?.skills || []),
        roblox_avatar_url: data?.roblox_avatar_url || null,
        is_online:        1,
        current_job_id:   data?.job_id || null,
        executor:         data?.executor || null,
        uptime:           Math.floor(data?.uptime || 0),
        total_kills:      Math.floor(data?.total_kills || 0),
        total_damage:     Math.floor(data?.total_damage || 0),
        total_vel_earned: Math.floor(data?.total_vel_earned || 0),
        inventory_count:  incomingInventory.length,
        inventory_hash:   incomingHash,
        version:          data?.version || null,
        eggs_found:       eggsFound,
        egg_hunt_runs:    eggRuns,
        accessory_chance: accChance,
        pity_data:        data?.pity_data ? JSON.stringify(data.pity_data) : null,
        floor_pity:       data?.floor_pity ? JSON.stringify(data.floor_pity) : null,
        farm_data:        data?.farm_data  ? JSON.stringify(data.farm_data)  : null,
        extra_stats:      data?.extra_stats? JSON.stringify(data.extra_stats): null,
        last_sync:        new Date(),
      }

      let accountId
      if (account) {
        const setClauses = Object.keys(fields).map(k => `\`${k}\` = ?`).join(', ')
        await query(
          `UPDATE accounts SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
          [...Object.values(fields), account.id]
        )
        accountId = account.id
      } else {
        const newId = uuidv4()
        fields.id = newId
        fields.session_start = new Date()
        const cols = Object.keys(fields).map(k => `\`${k}\``).join(', ')
        const vals = Object.keys(fields).map(() => '?').join(', ')
        await query(`INSERT INTO accounts (${cols}) VALUES (${vals})`, Object.values(fields))
        accountId = newId
      }

      // Update inventory only if changed
      if (inventoryChanged && incomingInventory.length > 0) {
        const existingInv = await queryOne('SELECT id FROM inventory WHERE account_id = ?', [accountId])
        if (existingInv) {
          await query(
            'UPDATE inventory SET items = ?, item_count = ?, hash = ?, updated_at = NOW() WHERE account_id = ?',
            [JSON.stringify(incomingInventory), incomingInventory.length, incomingHash, accountId]
          )
        } else {
          await query(
            'INSERT INTO inventory (id, account_id, user_id, items, item_count, hash) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), accountId, profile.id, JSON.stringify(incomingInventory), incomingInventory.length, incomingHash]
          )
        }
      }

      // Session management
      if (data?.job_id) {
        const existingSession = await queryOne(
          'SELECT id, drops_count FROM sessions WHERE account_id = ? AND job_id = ? AND ended_at IS NULL',
          [accountId, data.job_id]
        )
        if (existingSession) {
          await query(
            `UPDATE sessions SET duration_seconds = ?, floor_end = ?, level_end = ?,
             vel_earned = ?, kills = ? WHERE id = ?`,
            [data.uptime || 0, data.floor || '', data.level || 0,
             data.total_vel_earned || 0, data.total_kills || 0, existingSession.id]
          )
        } else {
          await query(
            `INSERT INTO sessions
             (id, account_id, user_id, job_id, executor, started_at,
              duration_seconds, floor_start, floor_end, level_start, level_end,
              vel_earned, kills, drops_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
            [uuidv4(), accountId, profile.id, data.job_id, data.executor || null,
             new Date(Date.now() - (data.uptime || 0) * 1000),
             data.uptime || 0, data.floor || '', data.floor || '',
             data.level || 0, data.level || 0]
          )
        }
      }

      return res.json({ success: true, account_id: accountId, inventory_updated: inventoryChanged })
    }

    // ── ACTION: drop ────────────────────────────────────────────
    if (action === 'drop') {
      if (!account) return res.status(404).json({ error: 'Account not found — sync first' })
      await query(
        `INSERT INTO drop_history (id, account_id, user_id, item_name, item_rarity, item_type, floor, mob_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), account.id, profile.id,
         data?.item_name || 'Unknown', data?.item_rarity || 'Common',
         data?.item_type || null, data?.floor || null, data?.mob_name || null]
      )
      return res.json({ success: true })
    }

    // ── ACTION: heartbeat ───────────────────────────────────────
    if (action === 'heartbeat') {
      if (!account) return res.status(404).json({ error: 'Account not found' })
      await query(
        'UPDATE accounts SET is_online = 1, last_sync = NOW(), uptime = ? WHERE id = ?',
        [data?.uptime || 0, account.id]
      )
      return res.json({ success: true })
    }

    // ── ACTION: offline ─────────────────────────────────────────
    if (action === 'offline') {
      if (!account) return res.json({ success: true })
      await query('UPDATE accounts SET is_online = 0, last_sync = NOW() WHERE id = ?', [account.id])

      const activeSessions = await query(
        'SELECT id FROM sessions WHERE account_id = ? AND ended_at IS NULL',
        [account.id]
      )
      for (const s of activeSessions) {
        await query(
          `UPDATE sessions SET ended_at = NOW(), duration_seconds = ?,
           floor_end = ?, level_end = ?, vel_earned = ?, kills = ?, drops_count = ?
           WHERE id = ?`,
          [data?.session?.duration || 0, data?.session?.floor_end || '',
           data?.session?.level_end || 0, data?.session?.vel_earned || 0,
           data?.session?.kills || 0, data?.session?.drops_count || 0, s.id]
        )
      }
      return res.json({ success: true })
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    console.error('Sync error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
