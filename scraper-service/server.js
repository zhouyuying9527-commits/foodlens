/**
 * 小红书爬虫微服务
 * 提供 POST /api/search 接口
 * 部署在 Fly.io 上，供 Vercel 主站调用
 */
const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Fly.io volume 挂载路径（持久化，重启不丢失）
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const COOKIES_PATH = path.join(fs.existsSync(DATA_DIR) ? DATA_DIR : __dirname, 'cookies.json');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
    });
  }
  return browser;
}

async function searchXhs(keywords, maxResults = 10) {
  if (!fs.existsSync(COOKIES_PATH)) {
    return { notes: [], error: 'No cookies configured' };
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  const now = Date.now() / 1000;
  const validCookies = cookies.filter(c => !c.expires || c.expires === -1 || c.expires === 0 || c.expires > now);

  const allNotes = [];
  const start = Date.now();

  try {
    const b = await getBrowser();
    const context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies(validCookies);

    // 先访问首页刷新 session
    const initPage = await context.newPage();
    await initPage.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await initPage.waitForTimeout(2000);

    // 检查登录状态
    const text = await initPage.evaluate(() => document.body.innerText.slice(0, 300));
    if (text.includes('登录') && !text.includes('首页')) {
      await initPage.close();
      await context.close();
      return { notes: [], error: 'Cookies expired, need re-login' };
    }

    // 保存刷新后的 cookies
    const freshCookies = await context.cookies();
    if (freshCookies.length > 0) {
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(freshCookies, null, 2));
    }
    await initPage.close();

    // 搜索
    for (const keyword of keywords) {
      if (allNotes.length >= maxResults) break;

      const page = await context.newPage();
      try {
        const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        // 等待内容加载
        try {
          await page.waitForSelector('a[href*="/explore/"], [class*="note"]', { timeout: 8000 });
        } catch (e) { /* continue */ }

        const notes = await page.evaluate(() => {
          const results = [];
          const seen = new Set();
          const links = document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]');

          links.forEach((link) => {
            const href = link.href || link.getAttribute('href') || '';
            if (seen.has(href) || !href) return;
            seen.add(href);

            let container = link;
            for (let i = 0; i < 5; i++) {
              if (container.parentElement) container = container.parentElement;
              if (container.offsetHeight > 100) break;
            }

            const titleEl = container.querySelector('[class*="title"], .title, h3') || link;
            const descEl = container.querySelector('[class*="desc"], [class*="content"], p');
            const likesEl = container.querySelector('[class*="like"] span, [class*="count"]');
            const authorEl = container.querySelector('[class*="author"], [class*="nickname"]');

            const title = titleEl ? titleEl.textContent.trim() : '';
            if (title && title.length > 2) {
              results.push({
                title: title.slice(0, 100),
                desc: descEl ? descEl.textContent.trim().slice(0, 200) : '',
                likes: likesEl ? likesEl.textContent.trim() : '0',
                author: authorEl ? authorEl.textContent.trim() : '',
                link: href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href,
              });
            }
          });
          return results;
        });

        notes.forEach(n => { n.keyword = keyword; });
        allNotes.push(...notes);
        console.log(`[XHS] "${keyword}" -> ${notes.length} notes`);

        // 防止封号：随机延迟
        await page.waitForTimeout(1000 + Math.random() * 2000);
      } catch (err) {
        console.log(`[XHS] "${keyword}" failed: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    await context.close();
  } catch (err) {
    console.error(`[XHS] Browser error: ${err.message}`);
    return { notes: allNotes.slice(0, maxResults), error: err.message };
  }

  return {
    notes: allNotes.slice(0, maxResults),
    elapsedMs: Date.now() - start,
    error: null,
  };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      hasCookies: fs.existsSync(COOKIES_PATH),
      uptime: process.uptime(),
    }));
  }

  // 搜索接口
  if (req.method === 'POST' && req.url === '/api/search') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { keywords, maxResults = 10 } = JSON.parse(body);
        if (!keywords || !keywords.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing keywords' }));
        }

        console.log(`[API] Search: ${keywords.join(', ')}`);
        const result = await searchXhs(keywords, maxResults);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 更新 cookies 接口
  if (req.method === 'POST' && req.url === '/api/update-cookies') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const cookies = JSON.parse(body);
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: cookies.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🔍 XHS Scraper Service running on port ${PORT}`);
  console.log(`   Cookies: ${fs.existsSync(COOKIES_PATH) ? 'loaded' : 'NOT FOUND'}`);
});
