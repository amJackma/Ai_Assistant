import express, { Request, Response, NextFunction } from 'express'
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

config()

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.json())
app.use(express.static(path.join(currentDirectory, 'dist')))

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  next()
})

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: process.env.npm_package_version || 'unknown',
  })
})

// API status endpoint
app.get('/api/status', (req: Request, res: Response) => {
  const apiKeyConfigured = !!process.env.OPENAI_API_KEY
  res.json({
    status: 'running',
    apiKeyConfigured,
    models: {
      fastAnswer: process.env.OPENAI_FAST_ANSWER_MODEL || 'gpt-5.6-luna',
      coding: process.env.OPENAI_CODING_MODEL || 'gpt-5.6-sol',
    },
  })
})

// Serve the frontend for any other route
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(currentDirectory, 'dist', 'index.html'))
})

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  })
})

app.listen(PORT, () => {
  console.log(`Interview Assistant server running on port ${PORT}`)
  console.log(`Environment: ${process.env.NODE_ENV}`)
  console.log(`Health check: http://localhost:${PORT}/api/health`)
})
