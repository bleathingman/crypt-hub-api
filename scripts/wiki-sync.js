// scripts/wiki-sync.js
// Usage: node scripts/wiki-sync.js
// Dumps SB2 wiki items into the wiki_items table

import 'dotenv/config'
import { query } from '../src/db/index.js'

const WIKI_API  = 'https://swordburst2.fandom.com/api.php'
const DELAY_MS  = 300  // be polite with the wiki API
const CATEGORIES = [
  '1HSword', '2HSword', 'Greatsword', 'Katana', 'Rapier', 'Lance',
  'Spear', 'Scythe', 'Sabre', 'Phaseblade',
  'Dagger', 'Stave', 'Hammer', 'Shield',
  'Armor', 'Accessory', 'Companions', 'Aura',
  'Material', 'Crystal', 'Skills'
]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function wikiGet(params) {
  const url = WIKI_API + '?' + new URLSearchParams({ ...params, format: 'json' }).toString()
  const res  = await fetch(url, { headers: { 'User-Agent': 'CrypTHub/1.0 wiki-sync' } })
  return res.json()
}

// ── Get all page titles in a category ────────────────────────
async function getCategoryMembers(cat) {
  const members = []
  let cmcontinue = null
  do {
    const params = {
      action: 'query', list: 'categorymembers',
      cmtitle: `Category:${cat}`, cmlimit: '500', cmtype: 'page'
    }
    if (cmcontinue) params.cmcontinue = cmcontinue
    const data = await wikiGet(params)
    ;(data.query?.categorymembers || []).forEach(m => members.push(m.title))
    cmcontinue = data.continue?.cmcontinue || null
  } while (cmcontinue)
  return members
}

// ── Parse wikitext infobox ────────────────────────────────────
function parseInfobox(wikitext) {
  if (!wikitext) return {}
  const start = wikitext.search(/\{\{\s*Item[_ ]infobox/i)
  if (start === -1) return {}

  let depth = 0, end = start
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext[i] === '{' && wikitext[i+1] === '{') { depth++; i++ }
    else if (wikitext[i] === '}' && wikitext[i+1] === '}') {
      if (--depth === 0) { end = i + 2; break }
      i++
    }
  }
  const block = wikitext.slice(start, end)
  const fields = {}
  const lines  = block.replace(/<gallery>[\s\S]*?<\/gallery>/gi, '').split('\n')
  let key = null, val = []

  const save = () => {
    if (!key) return
    const k = key.toLowerCase().trim()
    if (k && k !== 'image' && k !== 'name') {
      const v = val.join('\n')
        .replace(/\{\{[^|}][^}]*\}\}/g, '')
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
        .replace(/<[^>]+>/g, '').replace(/^\*\s*/gm, '').replace(/\}\}/g, '').trim()
      if (v) fields[k] = v
    }
    key = null; val = []
  }

  for (const line of lines) {
    const m = line.match(/^\|\s*([^|={}\n]+?)\s*=\s*(.*)$/)
    if (m) { save(); key = m[1]; val = [m[2]] }
    else if (key && line.trim() && !line.startsWith('{{') && !line.startsWith('}}')) val.push(line)
  }
  save()
  return fields
}

function extractNum(raw) {
  if (!raw) return null
  const cleanMatch = String(raw).match(/clean\s*:\s*([\d,]+)/i)
  const n = cleanMatch
    ? parseFloat(cleanMatch[1].replace(/,/g, ''))
    : parseFloat(String(raw).replace(/,/g, ''))
  return isNaN(n) ? null : n
}
function extractMax(raw) {
  if (!raw) return null
  const m = String(raw).match(/max\s*:\s*([\d,]+)/i)
  return m ? parseFloat(m[1].replace(/,/g, '')) : null
}
function find(fields, ...keys) {
  for (const k of keys) if (fields[k] != null && fields[k] !== '') return fields[k]
  return null
}

// ── Fetch + parse a single item page ─────────────────────────
async function fetchItem(title) {
  const pageName = title.replace(/ /g, '_')

  // Wikitext + images list
  const parseData = await wikiGet({ action: 'parse', page: pageName, prop: 'wikitext|images', redirects: '1' })
  if (parseData.error) return null
  const parse    = parseData.parse || {}
  const wikitext = parse.wikitext?.['*'] || ''
  const fields   = parseInfobox(wikitext)

  // Image: try pageimages thumbnail first
  let imageUrl = null
  try {
    const imgData = await wikiGet({ action: 'query', titles: pageName, prop: 'pageimages', pithumbsize: '200', redirects: '1' })
    const pages   = Object.values(imgData.query?.pages || {})
    imageUrl = pages[0]?.thumbnail?.source || null
  } catch (_) {}

  // Fallback: imageinfo on best matching file
  if (!imageUrl && parse.images?.length) {
    const base  = pageName.toLowerCase()
    const first = base.split('_')[0]
    const candidates = parse.images.filter(f => {
      const fn = f.toLowerCase()
      return !fn.includes('icon_') && !fn.includes('ui_') && !fn.includes('button') &&
             (fn.endsWith('.png') || fn.endsWith('.jpg') || fn.endsWith('.gif'))
    })
    const best = candidates.find(f => f.toLowerCase().includes(first)) || candidates[0]
    if (best) {
      try {
        const infoData = await wikiGet({ action: 'query', titles: `File:${best}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '200' })
        const p = Object.values(infoData.query?.pages || {})[0]
        imageUrl = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url || null
      } catch (_) {}
    }
  }

  const dmgRaw  = find(fields, 'dmg', 'damage', 'base damage')
  const defRaw  = find(fields, 'def', 'defense', 'defence')
  const typeRaw = find(fields, 'type', 'weapon type', 'item type') || ''
  const critRaw = find(fields, 'critical', 'crit', 'crit chance')

  return {
    name:          parse.title || title,
    image_url:     imageUrl,
    type:          typeRaw || null,
    level:         extractNum(find(fields, 'level', 'lvl', 'required level')),
    rarity:        find(fields, 'rarity') || null,
    damage_clean:  extractNum(dmgRaw),
    damage_max:    extractMax(dmgRaw),
    defense_clean: extractNum(defRaw),
    defense_max:   extractMax(defRaw),
    critical:      critRaw ? (String(critRaw).includes('%') ? critRaw : critRaw + '%') : null,
    source:        find(fields, 'obtain', 'source', 'drop') || null,
    cost:          find(fields, 'cost') || null,
    abilities:     find(fields, 'abilities', 'ability', 'passive') || null,
  }
}

// ── Upsert a single item into DB ──────────────────────────────
async function upsertItem(item) {
  await query(`
    INSERT INTO wiki_items
      (name, image_url, type, level, rarity,
       damage_clean, damage_max, defense_clean, defense_max,
       critical, source, cost, abilities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      image_url     = VALUES(image_url),
      type          = VALUES(type),
      level         = VALUES(level),
      rarity        = VALUES(rarity),
      damage_clean  = VALUES(damage_clean),
      damage_max    = VALUES(damage_max),
      defense_clean = VALUES(defense_clean),
      defense_max   = VALUES(defense_max),
      critical      = VALUES(critical),
      source        = VALUES(source),
      cost          = VALUES(cost),
      abilities     = VALUES(abilities),
      updated_at    = CURRENT_TIMESTAMP
  `, [
    item.name, item.image_url, item.type, item.level, item.rarity,
    item.damage_clean, item.damage_max, item.defense_clean, item.defense_max,
    item.critical, item.source, item.cost, item.abilities,
  ])
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Starting wiki sync...')
  const allTitles = new Set()

  for (const cat of CATEGORIES) {
    console.log(`📂 Category: ${cat}`)
    const titles = await getCategoryMembers(cat)
    titles.forEach(t => allTitles.add(t))
    await sleep(DELAY_MS)
  }

  console.log(`📦 ${allTitles.size} unique items found`)

  let done = 0, errors = 0
  for (const title of allTitles) {
    try {
      const item = await fetchItem(title)
      if (item) {
        await upsertItem(item)
        done++
        if (done % 50 === 0) console.log(`  ✅ ${done}/${allTitles.size}`)
      }
    } catch (e) {
      errors++
      console.error(`  ❌ ${title}: ${e.message}`)
    }
    await sleep(DELAY_MS)
  }

  console.log(`\n✅ Done — ${done} items synced, ${errors} errors`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })