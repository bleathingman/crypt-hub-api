import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRouter   from './routes/auth.js'
import syncRouter   from './routes/sync.js'
import dataRouter   from './routes/data.js'
import junkieRouter from './routes/junkie.js'

const app  = express()
const PORT = process.env.PORT || 3000

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'https://sb2.crypt-hub.fr',
    'https://crypt-hub.fr',
    'http://localhost:5173',
  ],
  credentials: true,
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ─── Routes ───────────────────────────────────────────────────
app.use('/auth',          authRouter)
app.use('/api/sync',      syncRouter)
app.use('/api/data',      dataRouter)
app.use('/api/junkie-verify', junkieRouter)

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }))

// ─── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }))

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

// ─── Start ────────────────────────────────────────────────────
if (typeof PhusionPassenger !== 'undefined') {
  // O2Switch / Phusion Passenger
  app.listen('passenger')
} else {
  app.listen(PORT, () => console.log(`CrypT Hub API running on port ${PORT}`))
}

export default app
