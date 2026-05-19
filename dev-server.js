/**
 * 本地开发服务器
 * 模拟 Vercel 环境：静态文件 + API serverless functions
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 加载 .env
require('dotenv').config();

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API 路由
  if (pathname.startsWith('/api/')) {
    const apiFile = path.join(__dirname, pathname + '.js');
    if (fs.existsSync(apiFile)) {
      try {
        // 清除 require 缓存（开发热重载）
        delete require.cache[require.resolve(apiFile)];
        const handler = require(apiFile);

        // 模拟 Vercel 的 req/res
        req.query = parsed.query;
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (data) => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(data));
        };

        await handler(req, res);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    } else {
      res.statusCode = 404;
      res.end('API not found');
    }
    return;
  }

  // 静态文件
  let filePath = path.join(__dirname, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const content = fs.readFileSync(filePath);
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.end(content);
  } else {
    // SPA fallback
    const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.setHeader('Content-Type', 'text/html');
    res.end(indexHtml);
  }
});

server.listen(PORT, () => {
  console.log(`\n  🍜 食探 FoodLens 本地开发服务器`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  SERPAPI_KEY: ${process.env.SERPAPI_KEY ? '已配置' : '未配置'}`);
  console.log(`  DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置'}`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
