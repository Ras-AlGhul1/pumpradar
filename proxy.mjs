import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'

const app = express()
const KEY = '30ec2243-f612-45e5-a461-408e71dd50df'

app.use('/api/pumpradar/rpc', createProxyMiddleware({
  target: 'https://mainnet.helius-rpc.com',
  changeOrigin: true,
  pathRewrite: { '^/api/pumpradar/rpc': '' },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.path = '/?api-key=' + KEY
    }
  }
}))

app.use('/api/pumpradar/transactions', createProxyMiddleware({
  target: 'https://api.helius.xyz',
  changeOrigin: true,
  pathRewrite: { '^/api/pumpradar/transactions': '' },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.path = '/v0/transactions/?api-key=' + KEY
    }
  }
}))

app.use('/api/pumpradar/metadata', createProxyMiddleware({
  target: 'https://api.helius.xyz',
  changeOrigin: true,
  pathRewrite: { '^/api/pumpradar/metadata': '' },
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

app.listen(3001, () => console.log('Proxy running on http://localhost:3001'))
