import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const KEY = process.env.HELIUS_API_KEY || '30ec2243-f612-45e5-a461-408e71dd50df'
const PORT = process.env.PORT || 3001

app.use('/api/pumpradar/rpc', createProxyMiddleware({
  target: 'https://mainnet.helius-rpc.com',
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.path = '/?api-key=' + KEY
    }
  }
}))

app.use('/api/pumpradar/transactions', createProxyMiddleware({
  target: 'https://api.helius.xyz',
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.path = '/v0/transactions/?api-key=' + KEY
    }
  }
}))

app.use('/api/pumpradar/metadata', createProxyMiddleware({
  target: 'https://api.helius.xyz',
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.path = '/v0/token-metadata/?api-key=' + KEY
    }
  }
}))

app.use('/api/pumpradar/price', createProxyMiddleware({
  target: 'https://price.jup.ag',
  changeOrigin: true,
  pathRewrite: { '^/api/pumpradar/price': '/v4/price' },
}))

// Serve the built React app
app.use(express.static(join(__dirname, 'dist')))
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
