import express from 'express'

const router = express.Router()
const WIKI_API = 'https://swordburst2.fandom.com/api.php'

const cache = new Map()
const CACHE_TTL = 3600000 // 1 hour

function getCached(key) {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data
  return null
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() })
  if (cache.size > 500) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

async function wikiRequest(params) {
  const key = JSON.stringify(params)
  const cached = getCached(key)
  if (cached) return cached
  const url = WIKI_API + '?' + new URLSearchParams({ ...params, format: 'json' }).toString()
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CrypTHub/1.0 (SB2 companion dashboard)' }
  })
  const data = await response.json()
  setCache(key, data)
  return data
}

function pickBestImage(images, itemTitle) {
  if (!images?.length) return null
  const base = itemTitle.replace(/_/g, ' ').toLowerCase()
  const firstWord = base.split(' ')[0]
  const candidates = images.filter(f => {
    const fn = f.toLowerCase()
    return !fn.includes('icon_') && !fn.includes('ui_') && !fn.includes('button') &&
           !fn.includes('background') && !fn.includes('logo') &&
           (fn.endsWith('.png') || fn.endsWith('.jpg') || fn.endsWith('.gif'))
  })
  return candidates.find(f => f.toLowerCase().includes(firstWord)) || candidates[0] || null
}

// ─── GET /wiki?action=item&q=... ─────────────────────────────
router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200')

  try {
    const { q, action: act } = req.query

    // ─── item ────────────────────────────────────────────────
    if (act === 'item' && q) {
      const cleanQ = q.replace(/\s*\+\d+$/, '').trim()
      let pageName = cleanQ.replace(/ /g, '_')

      let data = await wikiRequest({ action: 'parse', page: pageName, prop: 'wikitext|images', redirects: '1' })

      if (data.error) {
        const searchData = await wikiRequest({ action: 'query', list: 'search', srsearch: cleanQ, srnamespace: '0', srlimit: '1' })
        const firstResult = searchData.query?.search?.[0]
        if (firstResult) {
          pageName = firstResult.title.replace(/ /g, '_')
          data = await wikiRequest({ action: 'parse', page: pageName, prop: 'wikitext|images', redirects: '1' })
        }
      }

      if (data.error) return res.status(404).json({ error: 'Page not found', name: q })

      const parse = data.parse || {}

      let imageUrl = null
      try {
        const imgData = await wikiRequest({ action: 'query', titles: pageName, prop: 'pageimages', pithumbsize: '200', redirects: '1' })
        const pages = Object.values(imgData.query?.pages || {})
        imageUrl = pages[0]?.thumbnail?.source || null
      } catch (_) {}

      if (!imageUrl && parse.images?.length) {
        const bestFile = pickBestImage(parse.images, pageName)
        if (bestFile) {
          try {
            const infoData = await wikiRequest({ action: 'query', titles: `File:${bestFile}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '200' })
            const p = Object.values(infoData.query?.pages || {})[0]
            imageUrl = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url || null
          } catch (_) {}
        }
      }

      return res.json({
        title:    parse.title || q,
        pageid:   parse.pageid,
        images:   parse.images || [],
        wikitext: parse.wikitext,
        _image:   imageUrl,
        _wikiUrl: `https://swordburst2.fandom.com/wiki/${encodeURIComponent(pageName)}`,
      })
    }

    // ─── rarities ────────────────────────────────────────────
    if (act === 'rarities' && q) {
      const RARITY_CATS = ['Tribute', 'Legendary', 'Rare', 'Uncommon', 'Common', 'Burst']
      const names = q.split('|').slice(0, 50)
      const titles = names.map(n => n.replace(/ /g, '_')).join('|')

      const data = await wikiRequest({ action: 'query', titles, prop: 'categories', cllimit: '50', redirects: '1' })

      const results = {}
      Object.values(data.query?.pages || {}).forEach(page => {
        const cats = (page.categories || []).map(c => c.title.replace('Category:', ''))
        results[page.title] = RARITY_CATS.find(r => cats.includes(r)) || null
      })
      ;(data.query?.redirects || []).forEach(r => {
        if (results[r.to] && !results[r.from]) results[r.from.replace(/_/g, ' ')] = results[r.to]
      })

      return res.json(results)
    }

    // ─── search ──────────────────────────────────────────────
    if (act === 'search' && q) {
      const data = await wikiRequest({ action: 'query', list: 'search', srsearch: q, srnamespace: '0', srlimit: '10' })
      const results = (data.query?.search || []).map(r => ({
        title: r.title,
        snippet: r.snippet?.replace(/<[^>]+>/g, '') || '',
        url: `https://swordburst2.fandom.com/wiki/${r.title.replace(/ /g, '_')}`
      }))
      return res.json({ results })
    }

    // ─── category ────────────────────────────────────────────
    if (act === 'category' && q) {
      let allMembers = []
      let cmcontinue = null
      do {
        const params = {
          action: 'query', list: 'categorymembers',
          cmtitle: q.startsWith('Category:') ? q : `Category:${q}`,
          cmlimit: '50', cmtype: 'page'
        }
        if (cmcontinue) params.cmcontinue = cmcontinue
        const data = await wikiRequest(params)
        allMembers = allMembers.concat((data.query?.categorymembers || []).map(m => ({
          title: m.title, pageId: m.pageid,
          url: `https://swordburst2.fandom.com/wiki/${m.title.replace(/ /g, '_')}`
        })))
        cmcontinue = data.continue?.cmcontinue || null
      } while (cmcontinue && allMembers.length < 500)
      return res.json({ category: q, count: allMembers.length, items: allMembers })
    }

    // ─── batch ───────────────────────────────────────────────
    if (act === 'batch' && q) {
      const names = q.split('|').slice(0, 20)
      const cleanName = (n) => n.replace(/\s*\+\d+$/, '').trim()
      const cleanedNames = names.map(cleanName)
      const titles = cleanedNames.map(n => n.replace(/ /g, '_')).join('|')

      const data = await wikiRequest({ action: 'query', titles, prop: 'pageimages|images', pithumbsize: '200', imlimit: '10', redirects: '1' })

      const pages = data.query?.pages || {}
      const redirectMap = {}
      ;(data.query?.redirects || []).forEach(r => { redirectMap[r.from] = r.to })
      ;(data.query?.normalized || []).forEach(r => { redirectMap[r.from] = r.to })

      const results = {}
      const needImageInfo = []

      Object.values(pages).forEach(p => {
        const displayTitle = p.title?.replace(/_/g, ' ')
        if (p.thumbnail?.source) {
          if (p.title)      results[p.title]      = p.thumbnail.source
          if (displayTitle) results[displayTitle] = p.thumbnail.source
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
            const url = p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url
            if (fname && url) fileUrls[fname] = url
          })
          needImageInfo.forEach(({ pageTitle, file }) => {
            const url = fileUrls[file] || fileUrls[file.replace(/ /g, '_')]
            if (url) {
              results[pageTitle] = url
              results[pageTitle.replace(/_/g, ' ')] = url
            }
          })
        } catch (_) {}
      }

      names.forEach((origName, i) => {
        const clean = cleanedNames[i]
        const cleanSpace = clean.replace(/_/g, ' ')
        const cleanUnder = clean.replace(/ /g, '_')
        const resolved = redirectMap[cleanUnder] || redirectMap[cleanSpace]
        const url = results[origName] || results[clean] || results[cleanSpace] || results[cleanUnder]
              || (resolved && (results[resolved] || results[resolved.replace(/_/g, ' ')]))
        if (url && !results[origName]) results[origName] = url
      })

      return res.json(results)
    }

    return res.status(400).json({ error: 'Missing or invalid action' })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

export default router