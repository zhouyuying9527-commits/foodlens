/**
 * 食探 FoodLens — 小红书爬虫服务
 * 部署到 Fly.io，供 Vercel API 调用
 *
 * 接口：
 *   GET  /api/search?keyword=xxx   搜索关键词，返回笔记列表
 *   POST /api/cookies               更新 Cookie（用于重新登录）
 *   GET  /health                    健康检查
 */
const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_PATH = path.join(__dirname, "xhs-cookies.json");

let browser = null;
let cookies = null;
let lastLoadTime = 0;
const COOKIE_REFRESH_MS = 24 * 60 * 60 * 1000; // 24小时刷新一次

// 加载 Cookie
async function loadCookies() {
  try {
    const data = await fs.readFile(COOKIE_PATH, "utf-8");
    cookies = JSON.parse(data);
    lastLoadTime = Date.now();
    console.log(`[Scraper] Cookie 已加载 (${cookies.length} 条)`);
    return true;
  } catch (e) {
    console.log("[Scraper] Cookie 未找到，请先通过 POST /api/cookies 上传");
    return false;
  }
}

// 初始化浏览器
async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
      ],
    });
  }
}

// 清理 Cookie 格式
function sanitizeCookies(raw) {
  return raw.map((c) => {
    const cookie = { ...c };
    if (cookie.sameSite === "unspecified" || cookie.sameSite === "no_restriction") {
      cookie.sameSite = "None";
    } else if (cookie.sameSite) {
      cookie.sameSite = cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1).toLowerCase();
    }
    delete cookie.id;
    delete cookie.size;
    delete cookie.session;
    delete cookie.storeId;
    delete cookie.hostOnly;
    return cookie;
  });
}

// 搜索单个关键词
async function searchKeyword(keyword, limit = 5) {
  await initBrowser();

  // 定期刷新 Cookie
  if (!cookies || Date.now() - lastLoadTime > COOKIE_REFRESH_MS) {
    await loadCookies();
  }

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  });

  if (cookies && cookies.length > 0) {
    await context.addCookies(sanitizeCookies(cookies));
  }

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  const notes = [];

  try {
    // 访问首页建立 session
    await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(1500 + Math.random() * 1000);

    // 搜索页
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_note`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // 检查登录
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    if (pageText.includes("登录后查看")) {
      console.log(`[Scraper] "${keyword}" 需要登录`);
      await context.close();
      return [];
    }

    // 提取笔记
    const items = await page.evaluate((maxCount) => {
      const results = [];
      const processed = new Set();
      const links = document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]');

      for (const link of links) {
        if (results.length >= maxCount) break;
        const card = link.closest('section') || link.closest('[class*="note"]') || link.parentElement?.parentElement;
        if (!card || processed.has(card)) continue;
        processed.add(card);

        const title = card.querySelector('[class*="title"], .title, a span')?.textContent?.trim() || "";
        const desc = card.querySelector('[class*="desc"], .desc, [class*="content"]')?.textContent?.trim() || "";
        const likes = card.querySelector('[class*="like"] span, [class*="count"]')?.textContent?.trim() || "0";
        const author = card.querySelector('[class*="author"] .name, [class*="nickname"]')?.textContent?.trim() || "";

        if (title || desc) {
          results.push({ title: title || desc.slice(0, 50), desc: desc.slice(0, 200), likes, author, link: link.href });
        }
      }
      return results;
    }, limit);

    // 抓取正文（前 3 条无正文的笔记）
    for (let i = 0; i < Math.min(items.length, 3); i++) {
      const item = items[i];
      if (item.link && (!item.desc || item.desc.length < 10)) {
        try {
          await page.goto(item.link, { waitUntil: "domcontentloaded", timeout: 12000 });
          await page.waitForTimeout(1500 + Math.random() * 1000);
          const detail = await page.evaluate(() => {
            const el = document.querySelector('[class*="note-text"], [class*="desc"], #detail-desc, [class*="content"] .note-text');
            return (el?.textContent?.trim() || "").slice(0, 300);
          });
          if (detail && detail.length > 10) items[i].desc = detail;
        } catch (e) { /* ignore */ }
      }
    }

    notes.push(...items.map((item) => ({ ...item, keyword })));
  } catch (err) {
    console.error(`[Scraper] "${keyword}" 搜索失败:`, err.message);
  } finally {
    await context.close();
  }

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
  return notes;
}

// ── Routes ──

// 搜索接口
app.get("/api/search", async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.status(400).json({ error: "缺少 keyword 参数" });

  const start = Date.now();
  try {
    const notes = await searchKeyword(keyword, 5);
    res.json({
      keyword,
      notes,
      count: notes.length,
      elapsedMs: Date.now() - start,
    });
  } catch (err) {
    res.status(500).json({ error: "搜索失败", detail: err.message });
  }
});

// 多关键词批量搜索
app.post("/api/search", async (req, res) => {
  const { keywords, maxResults = 15 } = req.body;
  if (!keywords || !Array.isArray(keywords)) return res.status(400).json({ error: "需要 keywords 数组" });

  const start = Date.now();
  const allNotes = [];

  for (const kw of keywords.slice(0, 5)) {
    const notes = await searchKeyword(kw, Math.ceil(maxResults / keywords.length));
    allNotes.push(...notes);
    if (allNotes.length >= maxResults) break;
  }

  // 去重
  const seen = new Set();
  const unique = allNotes.filter((n) => {
    const key = (n.title || "").slice(0, 20);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json({
    keywords,
    notes: unique.slice(0, maxResults),
    count: unique.length,
    elapsedMs: Date.now() - start,
  });
});

// 更新 Cookie
app.post("/api/cookies", async (req, res) => {
  const { cookies: newCookies } = req.body;
  if (!newCookies || !Array.isArray(newCookies)) {
    return res.status(400).json({ error: "需要 cookies 数组" });
  }

  try {
    await fs.writeFile(COOKIE_PATH, JSON.stringify(newCookies, null, 2));
    cookies = newCookies;
    lastLoadTime = Date.now();
    res.json({ message: `Cookie 已更新 (${newCookies.length} 条)` });
  } catch (e) {
    res.status(500).json({ error: "保存失败", detail: e.message });
  }
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    hasCookies: !!cookies,
    cookieCount: cookies?.length || 0,
    uptime: process.uptime(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔍 FoodLens Scraper running on port ${PORT}`);
  loadCookies();
});

// 优雅关闭
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
