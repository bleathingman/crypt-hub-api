// scripts/wiki-fix.js
// Cleans wiki-dump.sql:
//   - removes "20px" prefix from cost values
//   - removes "|description=TBA" from source values
//   - moves "|abilities=..." leaking into critical/cost into the abilities column

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const FILE = resolve('scripts/wiki-dump.sql')

const COLS = ['name', 'image_url', 'type', 'level', 'rarity',
              'damage_clean', 'damage_max', 'defense_clean', 'defense_max',
              'critical', 'source', 'cost', 'abilities']
// indices:  0      1           2       3        4
//           5             6           7               8
//           9           10        11      12

// ── SQL string escaper ────────────────────────────────────────
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL'
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// ── Parse the content inside VALUES (...) ─────────────────────
// Returns array of string|null (one entry per column)
function parseValuesTuple(content) {
  const values = []
  let i = 0
  const len = content.length

  while (i < len) {
    while (i < len && /[\s,]/.test(content[i])) i++
    if (i >= len) break

    if (content.slice(i, i + 4) === 'NULL') {
      values.push(null)
      i += 4
    } else if (content[i] === "'") {
      i++ // skip opening quote
      let s = ''
      while (i < len) {
        if (content[i] === '\\' && i + 1 < len) {
          const nx = content[i + 1]
          s += nx === 'n' ? '\n' : nx
          i += 2
        } else if (content[i] === "'") {
          i++
          break
        } else {
          s += content[i++]
        }
      }
      values.push(s)
    } else {
      // bare word / number (shouldn't appear but handle gracefully)
      let s = ''
      while (i < len && content[i] !== ',' && content[i] !== ')') s += content[i++]
      values.push(s.trim() || null)
    }
  }
  return values
}

// ── Extract the raw content inside VALUES (...) ───────────────
// Uses a state machine to handle quoted strings with escapes
function extractTupleContent(block) {
  const start = block.indexOf('VALUES (') + 'VALUES ('.length
  let i = start
  let inStr = false

  while (i < block.length) {
    if (!inStr) {
      if (block[i] === "'") inStr = true
      else if (block[i] === ')') break
    } else {
      if (block[i] === '\\') i++ // skip escaped char
      else if (block[i] === "'") inStr = false
    }
    i++
  }
  return block.slice(start, i)
}

// ── Apply all data fixes ──────────────────────────────────────
function fixValues(v) {
  // 9=critical, 10=source, 11=cost, 12=abilities

  // critical: extract leaked |abilities=...
  if (v[9] && v[9].includes('|')) {
    const idx = v[9].indexOf('|')
    const tail = v[9].slice(idx + 1)
    if (/^abilities\s*=/i.test(tail)) {
      if (!v[12]) v[12] = tail.replace(/^abilities\s*=\s*/i, '').replace(/^\*\s*/, '').trim()
      v[9] = v[9].slice(0, idx).trim()
    }
  }

  // source: remove |description=TBA and similar |key=value suffixes
  if (v[10]) {
    v[10] = v[10]
      .replace(/\|description\s*=\s*TBA/gi, '')
      .replace(/\|[a-z_]+\s*=\s*[^|]*/gi, '')
      .trim()
  }

  // cost: remove "20px" prefix (wiki icon artifact)
  if (v[11]) v[11] = v[11].replace(/^20px\s*/i, '').trim()

  // cost: extract leaked |abilities=...
  if (v[11] && v[11].includes('|')) {
    const idx = v[11].indexOf('|')
    const tail = v[11].slice(idx + 1)
    if (/^abilities\s*=/i.test(tail)) {
      if (!v[12]) v[12] = tail.replace(/^abilities\s*=\s*/i, '').replace(/^\*\s*/, '').trim()
      v[11] = v[11].slice(0, idx).trim()
    }
  }

  // abilities: clean leading "* " bullets if any remain
  if (v[12]) v[12] = v[12].replace(/^\*\s*/, '').trim()

  // empty string → null
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '') v[i] = null
  }

  return v
}

// ── Rebuild a single INSERT statement ─────────────────────────
const ON_DUP = `  ON DUPLICATE KEY UPDATE
    image_url=VALUES(image_url), type=VALUES(type), level=VALUES(level),
    rarity=VALUES(rarity), damage_clean=VALUES(damage_clean), damage_max=VALUES(damage_max),
    defense_clean=VALUES(defense_clean), defense_max=VALUES(defense_max),
    critical=VALUES(critical), source=VALUES(source), cost=VALUES(cost),
    abilities=VALUES(abilities), updated_at=CURRENT_TIMESTAMP;`

function rebuildInsert(vals) {
  return `INSERT INTO wiki_items (${COLS.join(', ')}) VALUES (${vals.map(sqlVal).join(', ')})\n${ON_DUP}`
}

// ── Main ──────────────────────────────────────────────────────
const content = readFileSync(FILE, 'utf8')
const lines   = content.split('\n')

const output = []
let block  = []
let inBlock = false
let fixed  = 0, kept = 0, failed = 0

for (const line of lines) {
  if (line.startsWith('INSERT INTO')) {
    inBlock = true
    block   = [line]
  } else if (inBlock) {
    block.push(line)
    if (line.trimEnd().endsWith(';')) {
      const blockStr = block.join('\n')
      try {
        const tupleContent = extractTupleContent(blockStr)
        const vals = parseValuesTuple(tupleContent)
        if (vals.length === COLS.length) {
          const before = JSON.stringify(vals)
          const after  = JSON.stringify(fixValues([...vals]))
          const changed = before !== after
          output.push(rebuildInsert(fixValues(vals)))
          changed ? fixed++ : kept++
        } else {
          console.warn(`⚠ Unexpected column count (${vals.length}) — kept as-is`)
          output.push(blockStr)
          failed++
        }
      } catch (e) {
        console.error(`⚠ Parse error: ${e.message}`)
        output.push(blockStr)
        failed++
      }
      inBlock = false
      block   = []
    }
  } else {
    output.push(line)
  }
}

writeFileSync(FILE, output.join('\n'), 'utf8')
console.log(`✅ Done — ${fixed} rows fixed, ${kept} already clean, ${failed} kept as-is (parse error)`)
