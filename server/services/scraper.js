const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const COOKIE_PATH = path.join(__dirname, "..", "cookies", "xhs-cookies.json");

/**
 * 小红书搜索采集服务
 * 通过 Playwright 模拟用户在小红书上搜索餐厅相关笔记
 * 需要先运行 login-xhs.js 获取登录态 Cookie
 */
class XiaohongshuScraper {
  constructor() {
    this.browser = null;
    this.cookies = null;
  }

  /**
   * 加载已保存的 Cookie
   */
  _loadCookies() {
    try {
      if (fs.existsSync(COOKIE_PATH)) {
        this.cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
        console.log(`[Scraper] 已加载 ${this.cookies.length} 条 Cookie`);
        return true;
      }
    } catch (e) {
      console.error("[Scraper] Cookie 文件读取失败:", e.message);
    }
    console.log("[Scraper] ⚠️  未找到 Cookie 文件，请先运行: node server/login-xhs.js");
    this.cookies = null;
    return false;
  }

  async init() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      });
      this._loadCookies();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * 搜索小红书笔记
   */
  async search(keywords, maxResults = 15) {
    await this.init();
    const allNotes = [];

    for (const keyword of keywords) {
      try {
        console.log(`[Scraper] 正在搜索: "${keyword}"`);
        const notes = await this._searchKeyword(keyword, Math.ceil(maxResults / keywords.length));
        allNotes.push(...notes);
        console.log(`[Scraper] "${keyword}" 获取 ${notes.length} 条结果`);
      } catch (err) {
        console.error(`[Scraper] 搜索关键词 "${keyword}" 失败:`, err.message);
      }
    }

    const unique = this._dedup(allNotes);
    return unique.slice(0, maxResults);
  }

  async _searchKeyword(keyword, limit) {
    // 每次搜索前尝试加载最新 Cookie
    if (!this.cookies) {
      this._loadCookies();
    }

    const context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    // 注入 Cookie（修复 sameSite 格式）
    if (this.cookies && this.cookies.length > 0) {
      const sanitized = this.cookies.map((c) => {
        const cookie = { ...c };
        // Playwright 要求 sameSite 为 "Strict"|"Lax"|"None"
        if (cookie.sameSite === "unspecified" || cookie.sameSite === "no_restriction") {
          cookie.sameSite = "None";
        } else if (cookie.sameSite) {
          cookie.sameSite = cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1).toLowerCase();
        }
        // 删除 Playwright 不接受的字段
        delete cookie.id;
        delete cookie.size;
        delete cookie.session;
        delete cookie.storeId;
        delete cookie.hostOnly;
        return cookie;
      });
      await context.addCookies(sanitized);
      console.log("[Scraper] Cookie 已注入 (sanitized)");
    }

    const page = await context.newPage();

    // 反自动化检测
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = { runtime: {} };
    });

    const notes = [];

    try {
      // 先访问首页建立 session
      await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1500 + Math.random() * 1000);

      // 再导航到搜索页
      const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_note`;
      console.log(`[Scraper] 访问: ${searchUrl}`);

      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

      // 等待动态内容渲染
      await page.waitForTimeout(3000 + Math.random() * 2000);

      // 检查是否仍然需要登录
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
      if (pageText.includes("登录后查看")) {
        console.log("[Scraper] 页面仍要求登录，尝试截图调试...");
        // 保存截图用于调试
        const screenshotPath = path.join(__dirname, "..", "cookies", "debug-screenshot.png");
        await page.screenshot({ path: screenshotPath });
        console.log(`[Scraper] 截图已保存: ${screenshotPath}`);
        await context.close();
        await new Promise((r) => setTimeout(r, 1000));
        return notes;
      }

      // 等待笔记元素加载
      const selectors = [
        'section.note-item',
        '[class*="note-item"]',
        'a[href*="/explore/"]',
        'a[href*="/search_result/"]',
        'div[class*="feeds-page"] section',
        '[class*="note-card"]',
        '.search-result-container section',
      ];

      let found = false;
      for (const sel of selectors) {
        try {
          await page.waitForSelector(sel, { timeout: 5000 });
          found = true;
          console.log(`[Scraper] 找到元素: ${sel}`);
          break;
        } catch (e) {
          // 继续尝试
        }
      }

      if (!found) {
        console.log("[Scraper] 未找到笔记元素，页面内容预览:");
        console.log(`[Scraper] ${pageText.slice(0, 150)}`);
      }

      // 提取笔记数据
      const items = await page.evaluate((maxCount) => {
        const results = [];
        const processed = new Set();

        // 策略1: 通过链接找笔记
        const links = document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]');
        for (const link of links) {
          if (results.length >= maxCount) break;
          const card = link.closest('section') || link.closest('[class*="note"]') || link.parentElement?.parentElement;
          if (!card || processed.has(card)) continue;
          processed.add(card);

          const title = card.querySelector('[class*="title"], .title, a span')?.textContent?.trim() || "";
          const desc = card.querySelector('[class*="desc"], .desc, [class*="content"]')?.textContent?.trim() || "";
          const likes = card.querySelector('[class*="like"] span, [class*="count"], .like-wrapper span')?.textContent?.trim() || "0";
          const author = card.querySelector('[class*="author"] .name, [class*="nickname"], [class*="name"]')?.textContent?.trim() || "";

          if (title || desc) {
            results.push({ title: title || desc.slice(0, 50), desc: desc.slice(0, 200), likes, author, link: link.href });
          }
        }

        // 策略2: 通过 section / card 类名
        if (results.length < 3) {
          const cards = document.querySelectorAll('section, [class*="card"], [class*="note"]');
          for (const card of cards) {
            if (results.length >= maxCount) break;
            if (processed.has(card)) continue;
            processed.add(card);
            const text = card.textContent?.trim();
            if (text && text.length > 15 && text.length < 500 && !text.includes("登录")) {
              const titleMatch = text.split("\n")[0]?.trim() || text.slice(0, 50);
              results.push({ title: titleMatch, desc: text.slice(0, 200), likes: "0", author: "", link: "" });
            }
          }
        }

        return results;
      }, limit);

      // 对前 3 条有链接但没正文的笔记，点进详情页抓取正文
      for (let i = 0; i < Math.min(items.length, 3); i++) {
        const item = items[i];
        if (item.link && (!item.desc || item.desc.length < 10)) {
          try {
            console.log(`[Scraper] 抓取笔记正文: ${item.title.slice(0, 20)}...`);
            await page.goto(item.link, { waitUntil: "domcontentloaded", timeout: 12000 });
            await page.waitForTimeout(1500 + Math.random() * 1000);

            const detail = await page.evaluate(() => {
              // 小红书笔记详情页的正文选择器
              const descEl = document.querySelector('[class*="note-text"], [class*="desc"], #detail-desc, [class*="content"] .note-text');
              const desc = descEl?.textContent?.trim() || "";
              return desc.slice(0, 300);
            });

            if (detail && detail.length > 10) {
              items[i].desc = detail;
              console.log(`[Scraper] 正文获取成功 (${detail.length}字)`);
            }
          } catch (e) {
            // 获取失败不影响流程
            console.log(`[Scraper] 正文获取失败: ${e.message.slice(0, 50)}`);
          }
        }
      }

      notes.push(...items.map((item) => ({ ...item, keyword })));
    } catch (err) {
      console.error(`[Scraper] 页面加载失败 (${keyword}):`, err.message);
    } finally {
      await context.close();
    }

    // 随机延迟
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
    return notes;
  }

  /**
   * 搜索并提供降级
   */
  async searchWithFallback(keywords, maxResults = 15) {
    // 检查 Cookie 是否可用
    if (!this.cookies) {
      this._loadCookies();
    }

    if (!this.cookies) {
      console.log("[Scraper] 没有 Cookie，直接使用 demo 数据");
      return { notes: this._getDemoNotes(keywords[0]), fallback: true, message: "未配置小红书登录态，请先运行: node server/login-xhs.js" };
    }

    try {
      const results = await this.search(keywords, maxResults);

      if (results.length === 0) {
        console.log("[Scraper] 真实采集无结果，使用 demo 降级数据");
        // Cookie 可能过期，清除让下次重新加载
        this.cookies = null;
        return { notes: this._getDemoNotes(keywords[0]), fallback: true, message: "小红书采集无结果（Cookie可能已过期），请重新运行: node server/login-xhs.js" };
      }

      return { notes: results, fallback: false };
    } catch (err) {
      console.error("[Scraper] 采集异常，降级到 demo 数据:", err.message);
      return { notes: this._getDemoNotes(keywords[0]), fallback: true, message: "小红书采集异常，以下为示例数据展示效果" };
    }
  }

  /**
   * Demo 降级数据 - 当真实采集失败时使用
   */
  _getDemoNotes(keyword) {
    return [
      { title: `${keyword} 实测分享｜值得专门去一趟`, desc: "环境很好，服务态度也不错。菜品口味偏清淡，适合不太能吃辣的朋友。人均大概300人民币左右，性价比还可以。推荐他家的招牌菜，分量很足。", likes: "2.3k", author: "吃货小王", keyword },
      { title: `${keyword}｜排队2小时值不值？`, desc: "说实话味道确实不错，但排队时间太长了。建议工作日去，周末至少要等1-2小时。点了招牌套餐，够两个人吃。服务员会说英文，沟通没问题。", likes: "1.8k", author: "旅行日记", keyword },
      { title: `本地人推荐的${keyword}，没踩雷！`, desc: "这家是朋友推荐的，游客不多，本地人很多。菜单有英文也有图片，点餐方便。口味偏咸，但整体很正宗。现金信用卡都收，还能用支付宝。", likes: "956", author: "环球美食家", keyword },
      { title: `${keyword} 避雷！千万别点这个菜`, desc: "整体还行但有个大坑：他家的甜品太甜了，完全不是中国人能接受的甜度。主菜还可以，尤其推荐肉类。甜品直接跳过就好。另外注意他家午餐比晚餐便宜很多。", likes: "3.1k", author: "美食侦探", keyword },
      { title: `带爸妈去${keyword}，适合中国胃吗？`, desc: "带爸妈来的，老人家吃得挺开心。菜的口味不会太奇怪，也不会太油腻。有热汤，这点很加分。唯一的问题是位置不太好找，建议提前用Google Maps导航。人均200-250人民币。", likes: "1.2k", author: "孝顺旅行者", keyword },
      { title: `${keyword} 完整攻略｜怎么点餐不踩雷`, desc: "去了两次总结的攻略：1. 一定要预约，walk-in等很久；2. 招牌菜必点；3. 酒水单性价比不高，点水就行；4. 午餐套餐比单点划算；5. 可以刷Visa/Mastercard。", likes: "5.6k", author: "攻略达人", keyword },
      { title: `失望…${keyword}名不副实`, desc: "可能期望太高了。Google上4.8分，实际体验一般。服务很慢，等了40分钟才上菜。味道说不上难吃，但也没有惊艳到。可能是网红效应吧，不会再去第二次。", likes: "876", author: "真实点评", keyword },
    ];
  }

  _dedup(notes) {
    const seen = new Set();
    return notes.filter((note) => {
      const key = (note.title || note.desc || "").slice(0, 20);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = new XiaohongshuScraper();
