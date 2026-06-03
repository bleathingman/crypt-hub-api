import express from 'express'
import { apiKeyMiddleware } from '../middleware/auth.js'

const router = express.Router()

const SB2_PLACES = {
  "159518498":"Main Menu","659222129":"Main Menu","218380432":"Floor 1",
  "326086389":"Floor 2","555980327":"Floor 3","488934896":"Floor 4",
  "512067672":"Floor 5","566212942":"Floor 6","582198062":"Floor 7",
  "548878321":"Floor 8","573267292":"Floor 9","2659143505":"Floor 10",
  "5287433115":"Floor 11","6144637080":"Floor 12",
  "100233121448291":"Permafrost Purgatory","134019705603409":"Atlantis",
}
const SB2_SET = new Set(Object.keys(SB2_PLACES))

const MOD_IDS = [12671,4402987,7858636,13444058,24156180,35311411,38559058,45035796,48662268,50879012,51696441,55715138,57436909,59341698,60673083,62240513,66489540,68210875,72480719,75043989,76999375,81113783,90258662,93988508,101291900,102706901,104541778,109105759,111051084,121104177,129806297,151751026,154847513,154876159,161577703,161949719,163733925,167655046,167856414,173116569,184366742,194755784,220726786,225179429,269112100,271388254,309775741,349854657,354326302,357870914,358748060,367879806,371108489,373676463,429690599,434696913,440458342,448343431,454205259,455293249,461121215,478848349,500009807,533787513,542470517,571218846,575623917,630696850,810458354,852819491,874771971,918971121,1033291447,1033291716,1058240421,1099119770,1114937945,1190978597,1266604023,1379309318,1390415574,1416070243,1584345084,1607227678,1648776562,1650372835,1666720713,1728535349,1785469599,1794965093,1801714748,1868318363,1998442044,2034822362,2216826820,2324028828,2462374233,2787915712,360470140,2475151189,3522932153,3772282131,7557087747,5536587740,3931735673,33903799,22026533,417576199,80692318,102583875,492574273,468344010,24059009,80877763,1560324163,155428194,322230166,65349228,1601568635,125428691,376817661,1945168488,1196285251,198502544,382463861,668472978]

const roblosCookie = process.env.ROBLOX_COOKIE || ''
let cache = null, cacheTime = 0
const CACHE_TTL = 30000

async function fetchAll(noCache) {
  const now = Date.now()
  if (!noCache && cache && now - cacheTime < CACHE_TTL) return { data: cache, cached: true }

  const usernames = {}
  for (let i = 0; i < MOD_IDS.length; i += 100) {
    try {
      const r = await fetch('https://users.roblox.com/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: MOD_IDS.slice(i, i + 100), excludeBannedUsers: false }),
      })
      const d = await r.json()
      if (d.data) d.data.forEach(u => { usernames[u.id] = u.name })
    } catch {}
  }

  const hdrs = { 'Content-Type': 'application/json' }
  if (roblosCookie) hdrs['Cookie'] = '.ROBLOSECURITY=' + roblosCookie
  const raw = []
  for (let i = 0; i < MOD_IDS.length; i += 100) {
    try {
      const r = await fetch('https://presence.roblox.com/v1/presence/users', {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ userIds: MOD_IDS.slice(i, i + 100) }),
      })
      const d = await r.json()
      if (d.userPresences) raw.push(...d.userPresences)
    } catch {}
  }

  const cookieWorked = raw.some(p => p.userPresenceType === 2 && p.placeId && p.placeId !== 0)
  const allMods = MOD_IDS.map(id => {
    const s = String(id)
    const p = raw.find(r => String(r.userId) === s) || {}
    const pl = String(p.placeId || 0), rl = String(p.rootPlaceId || 0)
    const inSB2 = p.userPresenceType === 2 && (
      SB2_SET.has(pl) || SB2_SET.has(rl) ||
      p.universeId === 212154879 ||
      (p.lastLocation || '').toLowerCase().includes('swordburst')
    )
    return {
      roblox_id: s,
      name: usernames[id] || s,
      presence: p.userPresenceType || 0,
      in_sb2: inSB2,
      floor_name: inSB2 ? (SB2_PLACES[pl] || SB2_PLACES[rl] || 'SB2') : '',
      place_id: pl,
      root_place_id: rl,
      last_online: p.lastOnline || '',
      last_location: p.lastLocation || '',
    }
  })
  cache = allMods; cacheTime = now
  return { data: allMods, cached: false, cookieWorked }
}

router.get('/', apiKeyMiddleware, async (req, res) => {
  try {
    const r = await fetchAll(req.query.nocache === '1')
    const p = r.data
    res.json({
      in_sb2:        p.filter(x => x.in_sb2),
      in_other_game: p.filter(x => !x.in_sb2 && x.presence === 2),
      online:        p.filter(x => x.presence === 1),
      in_studio:     p.filter(x => x.presence === 3),
      offline:       p.filter(x => x.presence === 0),
      total:         p.length,
      _cookie_set:    !!roblosCookie,
      _cookie_len:    roblosCookie.length,
      _cookie_worked: r.cookieWorked || false,
      _cached:        r.cached || false,
    })
  } catch (e) {
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

export default router
