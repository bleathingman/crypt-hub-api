import express from 'express'
import { query } from '../db/index.js'

const router   = express.Router()
const WIKI_API = 'https://swordburst2.fandom.com/api.php'

const cache    = new Map()
const CACHE_TTL = 3600000

function getCached(key) {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data
  return null
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() })
  if (cache.size > 500) cache.delete(cache.keys().next().value)
}
async function wikiRequest(params) {
  const key    = JSON.stringify(params)
  const cached = getCached(key)
  if (cached) return cached
  const url  = WIKI_API + '?' + new URLSearchParams({ ...params, format: 'json' }).toString()
  const data = await fetch(url, { headers: { 'User-Agent': 'CrypTHub/1.0' } }).then(r => r.json())
  setCache(key, data)
  return data
}
function pickBestImage(images, itemTitle) {
  if (!images?.length) return null
  const first = itemTitle.replace(/_/g, ' ').toLowerCase().split(' ')[0]
  const candidates = images.filter(f => {
    const fn = f.toLowerCase()
    return !fn.includes('icon_') && !fn.includes('ui_') && !fn.includes('button') &&
           !fn.includes('background') && !fn.includes('logo') &&
           (fn.endsWith('.png') || fn.endsWith('.jpg') || fn.endsWith('.gif'))
  })
  return candidates.find(f => f.toLowerCase().includes(first)) || candidates[0] || null
}

// ── DB helpers ────────────────────────────────────────────────
async function dbGetItem(name) {
  try {
    const rows = await query('SELECT * FROM wiki_items WHERE name = ? LIMIT 1', [name])
    return rows[0] || null
  } catch (_) { return null }
}

async function dbGetMany(names) {
  if (!names.length) return {}
  try {
    const placeholders = names.map(() => '?').join(',')
    const rows = await query(`SELECT * FROM wiki_items WHERE name IN (${placeholders})`, names)
    const result = {}
    rows.forEach(r => { result[r.name] = r })
    return result
  } catch (_) { return {} }
}

// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200')
  try {
    const { q, action: act } = req.query

    // ─── item ────────────────────────────────────────────────
    if (act === 'item' && q) {
      const cleanQ = q.replace(/\s*\+\d+$/, '').trim()

      // DB first
      const dbRow = await dbGetItem(cleanQ)
      if (dbRow) {
        return res.json({
          title:    dbRow.name,
          _image:   dbRow.image_url,
          _fromDB:  true,
          _rawStats: {
            type:      dbRow.type,
            rarity:    dbRow.rarity,
            obtain:    dbRow.source,
            cost:      dbRow.cost,
            abilities: dbRow.abilities,
          },
          _stats: {
            lvl:        dbRow.level,
            isArmor:    (dbRow.type || '').toLowerCase().includes('armor'),
            damage:     dbRow.damage_clean,
            damageMax:  dbRow.damage_max,
            defense:    dbRow.defense_clean,
            defenseMax: dbRow.defense_max,
            crit:       dbRow.critical,
          },
        })
      }

      // Fallback: wiki API
      let pageName = cleanQ.replace(/ /g, '_')
      let data = await wikiRequest({ action: 'parse', page: pageName, prop: 'wikitext|images', redirects: '1' })
      if (data.error) {
        const s = await wikiRequest({ action: 'query', list: 'search', srsearch: cleanQ, srnamespace: '0', srlimit: '1' })
        const first = s.query?.search?.[0]
        if (first) {
          pageName = first.title.replace(/ /g, '_')
          data = await wikiRequest({ action: 'parse', page: pageName, prop: 'wikitext|images', redirects: '1' })
        }
      }
      if (data.error) return res.status(404).json({ error: 'Page not found', name: q })

      const parse = data.parse || {}
      let imageUrl = null
      try {
        const imgData = await wikiRequest({ action: 'query', titles: pageName, prop: 'pageimages', pithumbsize: '200', redirects: '1' })
        imageUrl = Object.values(imgData.query?.pages || {})[0]?.thumbnail?.source || null
      } catch (_) {}
      if (!imageUrl && parse.images?.length) {
        const best = pickBestImage(parse.images, pageName)
        if (best) {
          try {
            const infoData = await wikiRequest({ action: 'query', titles: `File:${best}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '200' })
            const p = Object.values(infoData.query?.pages || {})[0]
            imageUrl = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url || null
          } catch (_) {}
        }
      }
      return res.json({ title: parse.title || q, pageid: parse.pageid, images: parse.images || [], wikitext: parse.wikitext, _image: imageUrl })
    }

    // ─── batch ───────────────────────────────────────────────
    if (act === 'batch' && q) {
      const names        = q.split('|').slice(0, 20)
      const cleanName    = n => n.replace(/\s*\+\d+$/, '').trim()
      const cleanedNames = names.map(cleanName)

      // DB first — try exact match
      const dbRows  = await dbGetMany(cleanedNames)
      const results = {}
      const missing = []

      cleanedNames.forEach((clean, i) => {
        const row = dbRows[clean]
        if (row?.image_url) {
          results[names[i]] = row.image_url
          results[clean]    = row.image_url
        } else {
          missing.push({ orig: names[i], clean })
        }
      })

      // Wiki fallback for items not in DB
      if (missing.length) {
        const titles = missing.map(x => x.clean.replace(/ /g, '_')).join('|')
        const data   = await wikiRequest({ action: 'query', titles, prop: 'pageimages|images', pithumbsize: '200', imlimit: '10', redirects: '1' })
        const pages  = data.query?.pages || {}
        const redirectMap = {}
        ;(data.query?.redirects || []).forEach(r => { redirectMap[r.from] = r.to })
        ;(data.query?.normalized || []).forEach(r => { redirectMap[r.from] = r.to })

        const needImageInfo = []
        Object.values(pages).forEach(p => {
          const display = p.title?.replace(/_/g, ' ')
          if (p.thumbnail?.source) {
            if (p.title)  results[p.title]  = p.thumbnail.source
            if (display)  results[display]  = p.thumbnail.source
          } else {
            const imgFiles = (p.images || []).map(i => i.title?.replace('File:', '').replace(/_/g, ' ')).filter(Boolean)
            const best = pickBestImage(imgFiles, p.title || '')
            if (best) needImageInfo.push({ pageTitle: p.title || '', file: best })
          }
        })

        if (needImageInfo.length) {
          const fileTitles = [...new Set(needImageInfo.map(x => `File:${x.file}`))].join('|')
          try {
            const infoData = await wikiRequest({ action: 'query', titles: fileTitles, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '200' })
            const fileUrls = {}
            Object.values(infoData.query?.pages || {}).forEach(p => {
              const fname = p.title?.replace('File:', '').replace(/_/g, ' ')
              const url   = p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url
              if (fname && url) fileUrls[fname] = url
            })
            needImageInfo.forEach(({ pageTitle, file }) => {
              const url = fileUrls[file] || fileUrls[file.replace(/ /g, '_')]
              if (url) { results[pageTitle] = url; results[pageTitle.replace(/_/g, ' ')] = url }
            })
          } catch (_) {}
        }

        missing.forEach(({ orig, clean }) => {
          const cleanSpace = clean.replace(/_/g, ' ')
          const cleanUnder = clean.replace(/ /g, '_')
          const resolved   = redirectMap[cleanUnder] || redirectMap[cleanSpace]
          const url = results[orig] || results[clean] || results[cleanSpace] || results[cleanUnder]
                   || (resolved && (results[resolved] || results[resolved.replace(/_/g, ' ')]))
          if (url && !results[orig]) results[orig] = url
        })
      }

      return res.json(results)
    }

    // ─── rarities ────────────────────────────────────────────
    if (act === 'rarities' && q) {
      const names  = q.split('|').slice(0, 50)
      const dbRows = await dbGetMany(names)
      const results = {}
      const missing = []

      names.forEach(n => {
        if (dbRows[n]?.rarity) results[n] = dbRows[n].rarity
        else missing.push(n)
      })

      if (missing.length) {
        const RARITY_CATS = ['Tribute', 'Legendary', 'Rare', 'Uncommon', 'Common', 'Burst']
        const titles = missing.map(n => n.replace(/ /g, '_')).join('|')
        const data   = await wikiRequest({ action: 'query', titles, prop: 'categories', cllimit: '50', redirects: '1' })
        Object.values(data.query?.pages || {}).forEach(page => {
          const cats = (page.categories || []).map(c => c.title.replace('Category:', ''))
          results[page.title] = RARITY_CATS.find(r => cats.includes(r)) || null
        })
        ;(data.query?.redirects || []).forEach(r => {
          if (results[r.to] && !results[r.from]) results[r.from.replace(/_/g, ' ')] = results[r.to]
        })
      }

      return res.json(results)
    }

    // ─── search ──────────────────────────────────────────────
    if (act === 'search' && q) {
      const data = await wikiRequest({ action: 'query', list: 'search', srsearch: q, srnamespace: '0', srlimit: '10' })
      return res.json({ results: (data.query?.search || []).map(r => ({
        title: r.title,
        snippet: r.snippet?.replace(/<[^>]+>/g, '') || '',
        url: `https://swordburst2.fandom.com/wiki/${r.title.replace(/ /g, '_')}`
      }))})
    }

    // ─── category ────────────────────────────────────────────
    if (act === 'category' && q) {
      let allMembers = [], cmcontinue = null
      do {
        const params = { action: 'query', list: 'categorymembers', cmtitle: q.startsWith('Category:') ? q : `Category:${q}`, cmlimit: '50', cmtype: 'page' }
        if (cmcontinue) params.cmcontinue = cmcontinue
        const data = await wikiRequest(params)
        allMembers = allMembers.concat((data.query?.categorymembers || []).map(m => ({ title: m.title, pageId: m.pageid, url: `https://swordburst2.fandom.com/wiki/${m.title.replace(/ /g, '_')}` })))
        cmcontinue = data.continue?.cmcontinue || null
      } while (cmcontinue && allMembers.length < 500)
      return res.json({ category: q, count: allMembers.length, items: allMembers })
    }

    return res.status(400).json({ error: 'Missing or invalid action' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

export default router