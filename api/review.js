/**
 * GET /api/review
 * 中文口碑评价 + AI 分析
 * Vercel Serverless Function
 *
 * 数据获取优先级：
 * 1. 远程爬虫服务（Fly.io 小红书爬虫）
 * 2. 本地 Playwright 爬虫（需有效 cookies）
 * 3. SerpApi Google 搜索中文评价（从互联网获取真实评价）
 * 4. Demo 降级数据（最后手段）
 */

const cache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Demo 笔记（所有真实渠道都不可用时的最后降级）
function getDemoNotes(keyword) {
  return [
    { title: `${keyword} 实测分享｜值得专门去一趟`, desc: "环境很好，服务态度也不错。菜品口味偏清淡，适合不太能吃辣的朋友。人均大概300人民币左右。推荐他家的招牌菜，分量很足。", likes: "2.3k", author: "吃货小王", keyword },
    { title: `${keyword}｜排队2小时值不值？`, desc: "味道确实不错，但排队时间太长了。建议工作日去。点了招牌套餐，够两个人吃。服务员会说英文。", likes: "1.8k", author: "旅行日记", keyword },
    { title: `带爸妈去${keyword}，适合中国胃吗？`, desc: "带爸妈来的，老人家吃得挺开心。菜的口味不会太奇怪也不会太油腻。有热汤这点很加分。人均200-250人民币。", likes: "1.2k", author: "孝顺旅行者", keyword },
  ];
}

// SerpApi Google 搜索中文评价
async function fetchWebReviews(name, city) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  try {
    // 搜索策略：餐厅名 + 城市 + 美食相关中文关键词
    const queries = [
      `"${name}" ${city} 餐厅 推荐`,
      `${name} ${city} 好吃 美食 点评`,
    ];

    const allNotes = [];

    for (const q of queries) {
      if (allNotes.length >= 8) break;

      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&hl=zh-cn&num=10&api_key=${apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) continue;
      const data = await response.json();

      const results = data.organic_results || [];
      for (const r of results) {
        if (!r.snippet || r.snippet.length < 30) continue;
        // 过滤不相关的结果
        if (r.link?.includes('ad.xiaohongshu.com')) continue;
        if (r.link?.includes('booking.com')) continue;
        if (r.link?.includes('airbnb.')) continue;
        if (r.link?.includes('hotels.com')) continue;
        // 只保留可能包含餐厅评价的内容
        const text = `${r.title} ${r.snippet}`.toLowerCase();
        const foodRelated = ['餐', '美食', '吃', '味', '推荐', '菜', '好吃', '点评', 'restaurant', 'food', '厅', '馆', '料理', '米其林'].some(w => text.includes(w));
        if (!foodRelated) continue;

        allNotes.push({
          title: r.title || '',
          desc: r.snippet || '',
          likes: '',
          author: extractSource(r.link),
          link: r.link || '',
          keyword: name,
        });
      }
    }

    if (allNotes.length > 0) {
      // 去重（按 link）
      const seen = new Set();
      const unique = allNotes.filter(n => {
        if (seen.has(n.link)) return false;
        seen.add(n.link);
        return true;
      });
      console.log(`[Review] Google 搜索返回 ${unique.length} 条中文餐厅评价`);
      return unique.slice(0, 10);
    }
  } catch (err) {
    console.log(`[Review] Google 搜索失败: ${err.message}`);
  }
  return null;
}

function extractSource(url) {
  if (!url) return '';
  try {
    const host = new URL(url).hostname.replace('www.', '');
    const sources = {
      'xiaohongshu.com': '小红书',
      'tripadvisor.cn': 'TripAdvisor',
      'tripadvisor.com': 'TripAdvisor',
      'dianping.com': '大众点评',
      'zhihu.com': '知乎',
      'weibo.com': '微博',
      'douban.com': '豆瓣',
      'mafengwo.cn': '马蜂窝',
      'sohu.com': '搜狐',
      'sina.com': '新浪',
      'threads.com': 'Threads',
      'zhuanlan.zhihu.com': '知乎专栏',
    };
    for (const [domain, name] of Object.entries(sources)) {
      if (host.includes(domain)) return name;
    }
    return host.split('.').slice(-2, -1)[0] || '';
  } catch { return ''; }
}

// DeepSeek API URL 构建
function getDeepSeekUrl() {
  const base = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  if (base.includes('/chat/completions')) return base;
  return base.replace(/\/$/, '') + '/v1/chat/completions';
}

// DeepSeek 关键词生成
async function generateKeywords(name, city) {
  try {
    const prompt = `你是小红书搜索优化助手。餐厅原名：${name}，城市：${city}。生成2-3个搜索关键词，必须包含完整餐厅原名。返回JSON数组。`;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return [name, `${name} ${city}`];

    const response = await fetch(getDeepSeekUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 150 }),
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) { console.log(`[Review] DeepSeek 关键词生成失败: ${e.message}`); }
  return [name, `${name} ${city}`];
}

// DeepSeek 评价分析
async function analyzeReviews(restaurantName, city, notes) {
  try {
    const notesText = notes.map((n, i) => `[${i + 1}] 标题：${n.title}\n内容：${n.desc}`).join("\n\n");
    const prompt = `你是帮助中国游客做海外餐厅决策的AI。目标餐厅：「${restaurantName}」（${city}）\n笔记：\n${notesText}\n\n请按JSON输出：{"relevantNoteCount":3,"rating":"recommend","summary":"一句话总结","chineseStomachIndex":{"score":4,"reason":"实质口味描述，禁止出现笔记[1]等指代"},"recommendedDishes":[{"name":"菜名","reason":"实质推荐理由，禁止笔记[1]提及类废话"}],"needReservation":"需要提前预约","pros":["..."],"cons":["..."],"practicalInfo":{"avgPrice":"...","waitTime":"...","paymentMethod":"...","tips":"..."},"adCount":0,"confidence":"high"}`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.log("[Review] 无 DEEPSEEK_API_KEY，使用 fallback 分析");
      return fallbackAnalyze(notes);
    }

    const deepseekUrl = getDeepSeekUrl();
    console.log(`[Review] 调用 DeepSeek: ${deepseekUrl}`);

    const response = await fetch(deepseekUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 1000 }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.log(`[Review] DeepSeek HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return fallbackAnalyze(notes);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    console.log(`[Review] DeepSeek 返回 ${text.length} 字符`);

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      result.noteCount = notes.length;
      return result;
    }
    console.log(`[Review] DeepSeek 返回格式异常: ${text.slice(0, 100)}`);
  } catch (e) { console.log(`[Review] DeepSeek 分析失败: ${e.message}`); }
  return fallbackAnalyze(notes);
}

function fallbackAnalyze(notes) {
  const texts = notes.map((n) => `${n.title} ${n.desc}`).join(" ");
  const posWords = ["推荐", "好吃", "正宗", "值得", "惊艳", "必点", "不错"];
  const negWords = ["避雷", "踩雷", "失望", "难吃", "不推荐"];
  let posCount = 0, negCount = 0;
  posWords.forEach((w) => { posCount += (texts.match(new RegExp(w, "g")) || []).length; });
  negWords.forEach((w) => { negCount += (texts.match(new RegExp(w, "g")) || []).length; });
  const total = posCount + negCount || 1;
  const posRatio = posCount / total;
  let rating = posRatio > 0.8 ? "strongly_recommend" : posRatio > 0.6 ? "recommend" : posRatio > 0.4 ? "caution" : "avoid";
  let ratingLabel = { strongly_recommend: "强烈推荐", recommend: "推荐", caution: "谨慎", avoid: "避雷" }[rating];
  const priceMatch = texts.match(/人均[约]?(\d+)/);
  return {
    rating, ratingLabel, summary: `基于${notes.length}条笔记的分析`,
    pros: [], cons: [],
    practicalInfo: { avgPrice: priceMatch ? `约${priceMatch[1]}元` : null },
    noteCount: notes.length, adCount: 0, confidence: "medium", analysisMode: "local",
  };
}

// 获取中文评价：远程爬虫 → 本地 Playwright → SerpApi Google → demo
async function fetchXhsNotes(keywords, restaurantName, city) {
  const scraperUrl = process.env.SCRAPER_URL;

  // 1. 远程爬虫服务（Fly.io 等）
  if (scraperUrl) {
    try {
      const response = await fetch(`${scraperUrl}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, maxResults: 15 }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.notes && data.notes.length > 0) {
        console.log(`[Review] 远程爬虫返回 ${data.notes.length} 条笔记 (${data.elapsedMs}ms)`);
        return { notes: data.notes, fallback: false, message: null, source: "xiaohongshu" };
      }
    } catch (err) {
      console.log(`[Review] 远程爬虫不可用: ${err.message}`);
    }
  }

  // 2. SerpApi Google 搜索中文评价（可靠且无需登录）
  const webNotes = await fetchWebReviews(restaurantName, city);
  if (webNotes && webNotes.length > 0) {
    return { notes: webNotes, fallback: false, message: null, source: "web_reviews" };
  }

  // 3. 本地 Playwright 爬虫（仅本地开发环境，Vercel 跳过）
  if (!process.env.VERCEL) {
    try {
      const { searchXhs } = require('../local-scraper');
      console.log(`[Review] 尝试本地 Playwright 爬虫...`);
      const notes = await searchXhs(keywords, 15);
      if (notes.length > 0) {
        console.log(`[Review] 本地爬虫返回 ${notes.length} 条真实笔记`);
        return { notes, fallback: false, message: null, source: "xiaohongshu" };
      }
    } catch (err) {
      console.log(`[Review] 本地爬虫不可用: ${err.message}`);
    }
  }

  // 4. 最终降级到 demo 数据
  return { notes: getDemoNotes(keywords[0]), fallback: true, message: "暂未获取到该餐厅的中文评价数据", source: "demo" };
}

module.exports = async (req, res) => {
  const { name, city = "Paris" } = req.query;
  if (!name) return res.status(400).json({ error: "缺少餐厅名称" });

  const cacheKey = `${name}-${city}`;
  if (cache.has(cacheKey) && Date.now() - cache.get(cacheKey).time < CACHE_TTL) {
    return res.json(cache.get(cacheKey).data);
  }

  const start = Date.now();
  console.log(`[Review] 开始处理: ${name} (${city})`);

  // 关键词生成
  const keywords = await generateKeywords(name, city);
  console.log(`[Review] 关键词: ${keywords.join(", ")}`);

  // 中文评价采集（多通道）
  const { notes, fallback, message, source } = await fetchXhsNotes(keywords, name, city);
  console.log(`[Review] 采集到 ${notes.length} 条评价 [来源: ${source}]`);

  // AI 分析
  const analysis = await analyzeReviews(name, city, notes);

  const result = {
    restaurant: { name, city },
    ...analysis,
    keywords,
    rawNotes: notes.slice(0, 5).map((n) => ({
      title: n.title,
      desc: n.desc?.slice(0, 100) || "",
      likes: n.likes || "0",
      author: n.author || "",
      link: n.link || "",
    })),
    elapsedMs: Date.now() - start,
    cached: false,
    dataSource: source,
    dataSourceMessage: fallback && message ? message : null,
  };

  cache.set(cacheKey, { data: result, time: Date.now() });
  if (cache.size > 1000) { const k = cache.keys().next().value; cache.delete(k); }

  res.json(result);
};
