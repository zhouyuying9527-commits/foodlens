/**
 * 小红书爬虫 - 本地 Playwright 版本 (v2)
 * 先访问首页刷新 cookies，再搜索
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIES_PATH = path.join(__dirname, 'server', 'cookies', 'xhs-cookies.json');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function searchXhs(keywords, maxResults = 10) {
  const cookiesExist = fs.existsSync(COOKIES_PATH);
  if (!cookiesExist) {
    console.log("[XHS Scraper] 无 cookies 文件，跳过爬取");
    return [];
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  // 过滤掉已过期的 cookies
  const now = Date.now() / 1000;
  const validCookies = cookies.filter(c => !c.expires || c.expires === -1 || c.expires === 0 || c.expires > now);
  console.log(`[XHS Scraper] 有效 cookies: ${validCookies.length}/${cookies.length}`);

  const allNotes = [];

  try {
    const b = await getBrowser();
    const context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });

    await context.addCookies(validCookies);

    // 先访问首页刷新 session
    const initPage = await context.newPage();
    console.log("[XHS Scraper] 访问首页刷新 session...");
    await initPage.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await initPage.waitForTimeout(2000);

    // 检查是否登录成功
    const pageText = await initPage.evaluate(() => document.body.innerText.slice(0, 200));
    if (pageText.includes('登录') && !pageText.includes('退出') && !pageText.includes('我')) {
      console.log("[XHS Scraper] cookies 已失效，需要重新登录");
      await initPage.close();
      await context.close();
      return [];
    }
    
    // 保存刷新后的 cookies
    const freshCookies = await context.cookies();
    if (freshCookies.length > 0) {
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(freshCookies, null, 2));
      console.log(`[XHS Scraper] 已更新 ${freshCookies.length} 个 cookies`);
    }
    await initPage.close();

    // 逐个关键词搜索
    for (const keyword of keywords) {
      if (allNotes.length >= maxResults) break;

      const page = await context.newPage();
      try {
        const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
        console.log(`[XHS Scraper] 搜索: "${keyword}"`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        // 等待笔记内容加载
        try {
          await page.waitForSelector('[class*="note"], [class*="feeds-page"] a, .search-result-container a', { timeout: 8000 });
        } catch (e) {
          // 可能没有匹配的选择器，继续尝试提取
        }

        // 提取笔记列表 - 多种选择器策略
        const notes = await page.evaluate(() => {
          const results = [];
          
          // 策略1: 通过 explore 链接找笔记卡片
          const exploreLinks = document.querySelectorAll('a[href*="/explore/"], a[href*="/search_result/"]');
          const seen = new Set();
          
          exploreLinks.forEach((link) => {
            const href = link.href || link.getAttribute('href') || '';
            if (seen.has(href) || !href) return;
            seen.add(href);
            
            // 找到笔记卡片容器（向上查找）
            let container = link;
            for (let i = 0; i < 5; i++) {
              if (container.parentElement) container = container.parentElement;
              // 检查容器是否足够大（可能是卡片）
              if (container.offsetHeight > 100) break;
            }
            
            const titleEl = container.querySelector('[class*="title"], .title, h3, [class*="name"]') || link;
            const descEl = container.querySelector('[class*="desc"], [class*="content"], p');
            const likesEl = container.querySelector('[class*="like"] span, [class*="count"], [class*="interact"]');
            const authorEl = container.querySelector('[class*="author"], [class*="nickname"], [class*="user"]');
            
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
          
          // 策略2: 通过 feeds-page 下的子容器
          if (results.length === 0) {
            const feedsPage = document.querySelector('[class*="feeds-page"], [class*="search-result"]');
            if (feedsPage) {
              const sections = feedsPage.querySelectorAll('section, [class*="note-item"], div[class*="note"]');
              sections.forEach((section) => {
                const link = section.querySelector('a');
                const title = section.querySelector('[class*="title"], h3, .title');
                if (title && title.textContent.trim()) {
                  results.push({
                    title: title.textContent.trim().slice(0, 100),
                    desc: '',
                    likes: '0',
                    author: '',
                    link: link ? (link.href || '') : '',
                  });
                }
              });
            }
          }
          
          return results;
        });

        notes.forEach((n) => { n.keyword = keyword; });
        allNotes.push(...notes);
        console.log(`[XHS Scraper] "${keyword}" 找到 ${notes.length} 条笔记`);
      } catch (err) {
        console.log(`[XHS Scraper] "${keyword}" 搜索失败: ${err.message}`);
      } finally {
        await page.close();
      }
    }

    await context.close();
  } catch (err) {
    console.log(`[XHS Scraper] 浏览器错误: ${err.message}`);
  }

  return allNotes.slice(0, maxResults);
}

module.exports = { searchXhs };
