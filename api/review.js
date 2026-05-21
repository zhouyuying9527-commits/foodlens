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
    // 搜索策略：餐厅名 + 城市（强制包含城市名）
    const queries = [
      `"${name}" "${city}" 餐厅`,
      `"${name}" ${city} 好吃 推荐`,
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

        // 相关性校验：结果必须包含餐厅名或城市名的关键部分
        const nameKey = name.toLowerCase().split(/\s+/)[0]; // 取餐厅名第一个词
        const cityKey = city.toLowerCase().replace(/\s.*/, ''); // 取城市名第一个词
        const contentLower = text;
        const hasName = contentLower.includes(nameKey);
        const hasCity = contentLower.includes(cityKey);
        // 至少要包含餐厅名，最好也包含城市
        if (!hasName) continue;

        allNotes.push({
          title: r.title || '',
          desc: r.snippet || '',
          likes: '',
          author: extractSource(r.link),
          link: r.link || '',
          keyword: name,
          lang: 'zh',
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

// SerpApi Google 搜索本地语言评价（用于本地指数）
async function fetchLocalReviews(name, city) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  // 城市对应的本地语言和搜索关键词
  const cityLangMap = {
    'Paris': { hl: 'fr', keywords: 'avis restaurant' },
    '巴黎': { hl: 'fr', keywords: 'avis restaurant' },
    'Tokyo': { hl: 'ja', keywords: 'レストラン 口コミ' },
    '东京': { hl: 'ja', keywords: 'レストラン 口コミ' },
    'Bangkok': { hl: 'th', keywords: 'ร้านอาหาร รีวิว' },
    '曼谷': { hl: 'th', keywords: 'ร้านอาหาร รีวิว' },
    'London': { hl: 'en', keywords: 'restaurant review' },
    '伦敦': { hl: 'en', keywords: 'restaurant review' },
    'New York': { hl: 'en', keywords: 'restaurant review' },
    '纽约': { hl: 'en', keywords: 'restaurant review' },
    'Seoul': { hl: 'ko', keywords: '맛집 리뷰' },
    '首尔': { hl: 'ko', keywords: '맛집 리뷰' },
    'Rome': { hl: 'it', keywords: 'ristorante recensioni' },
    '罗马': { hl: 'it', keywords: 'ristorante recensioni' },
    'Barcelona': { hl: 'es', keywords: 'restaurante opiniones' },
    '巴塞罗那': { hl: 'es', keywords: 'restaurante opiniones' },
  };

  const langConfig = cityLangMap[city] || { hl: 'en', keywords: 'restaurant review' };

  try {
    const q = `"${name}" ${city} ${langConfig.keywords}`;
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&hl=${langConfig.hl}&num=8&api_key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const data = await response.json();

    const results = data.organic_results || [];
    const localNotes = [];
    const nameKey = name.toLowerCase().split(/\s+/)[0];
    for (const r of results) {
      if (!r.snippet || r.snippet.length < 20) continue;
      if (r.link?.includes('booking.com')) continue;
      if (r.link?.includes('airbnb.')) continue;
      // 相关性：至少包含餐厅名关键词
      const text = `${r.title} ${r.snippet}`.toLowerCase();
      if (!text.includes(nameKey)) continue;
      localNotes.push({
        title: r.title || '',
        desc: r.snippet || '',
        author: extractSource(r.link),
        link: r.link || '',
        lang: langConfig.hl,
      });
    }
    console.log(`[Review] 本地语言(${langConfig.hl})搜索返回 ${localNotes.length} 条评价`);
    return localNotes.slice(0, 8);
  } catch (err) {
    console.log(`[Review] 本地语言搜索失败: ${err.message}`);
    return [];
  }
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

// DeepSeek API URL 构建（兼容各种 BASE_URL 写法）
function getDeepSeekUrl() {
  const base = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, '');
  // 已经是完整路径
  if (base.includes('/chat/completions')) return base;
  // 包含 /v1 但没有后续路径
  if (base.endsWith('/v1')) return base + '/chat/completions';
  // 只有域名
  return base + '/v1/chat/completions';
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

// DeepSeek 评价分析（双指数版本）
async function analyzeReviews(restaurantName, city, notes, localNotes) {
  try {
    const notesText = notes.map((n, i) => `[中文${i + 1}] 标题：${n.title}\n内容：${n.desc}`).join("\n\n");
    const localNotesText = localNotes && localNotes.length > 0
      ? localNotes.map((n, i) => `[本地${i + 1}] 标题：${n.title}\n内容：${n.desc}`).join("\n\n")
      : "（暂无本地语言评价数据）";

    const prompt = `你是一个帮中国游客挑餐厅的助手，说话要像朋友推荐一样自然口语化，不要用书面语。

餐厅：「${restaurantName}」（${city}）

===== 中文评价 =====
${notesText}

===== 本地语言评价 =====
${localNotesText}

重要：首先判断上面的评价内容是否真的在讨论「${restaurantName}」这家位于「${city}」的餐厅。如果评价内容明显是在说其他城市的同名餐厅、或者与这家店完全无关，请直接返回：
{"rating": "no_data", "summary": "暂未找到这家餐厅的相关评价", "confidence": "low"}

只有当评价内容确实与这家餐厅相关时，才输出完整分析JSON（所有文字必须口语化、像朋友聊天，严禁出现"中文评价提到""评论指出"等来源引用）：
{
  "rating": "strongly_recommend/recommend/caution/avoid",
  "summary": "一句话，像朋友推荐那样说这家店值不值得去",

  "chineseStomachIndex": {
    "score": 1到5的整数,
    "reason": "用一句大白话说适不适合中国人的口味，为什么。比如：'味道偏西式但不踩雷，大部分人能接受' 或 '口味偏重香料，不太适合清淡口的朋友'"
  },

  "localIndex": {
    "score": 1到5的整数,
    "reason": "用一句大白话说当地人认不认这家店。比如：'本地人常去的老店，口碑很稳' 或 '主要是游客在排队，本地人不太来'"
  },

  "recommendedDishes": [
    {"name": "菜名", "reason": "为什么推荐，口语化"}
  ],
  "pros": ["好评要点，直接说结论"],
  "cons": ["差评要点，仅限味道/服务/卫生等真实体验问题"],
  "tips": ["实用提醒，如：记得提前预约、中午去不用排队"],
  "practicalInfo": {
    "avgPrice": "人均价格",
    "waitTime": "等位时间",
    "paymentMethod": "支付方式"
  },
  "confidence": "high/medium/low"
}

评分说明：
【中国胃指数】1-5星，只看"中国人吃了会不会觉得好吃/习惯"：
- 5星：口味很合中国人，热食多，有米饭面条，调味熟悉
- 4星：大部分中国人能接受，偶尔有不太习惯的菜
- 3星：需要挑着点，有些菜可能吃不惯
- 2星：口味差异比较大，不少菜对中国胃是挑战
- 1星：大部分中国人会吃不惯

【本地指数】1-5星，只看"当地人认不认可这家店"（跟菜系无关！法餐、中餐、融合菜都可以是本地认可的好店）：
- 5星：本地人的心头好，评价活跃且评分高，不是靠游客撑起来的
- 4星：本地口碑不错，当地人会去吃
- 3星：本地人和游客都有，不算特别本地也不算游客店
- 2星：游客比本地人多，有点网红打卡的感觉
- 1星：基本都是游客在去，本地人不太认

重要：本地指数和菜系类型完全无关。一家法餐在巴黎、一家中餐在巴黎，都可以得5星本地指数，只要当地人真的认可它。`;

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
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 1500 }),
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
      result.localNoteCount = localNotes ? localNotes.length : 0;
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
    pros: [], cons: [], tips: [],
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

  // 并行获取：中文评价 + 本地语言评价
  const [xhsResult, localNotes] = await Promise.all([
    fetchXhsNotes(keywords, name, city),
    fetchLocalReviews(name, city),
  ]);
  const { notes, fallback, message, source } = xhsResult;
  console.log(`[Review] 采集到 ${notes.length} 条中文评价 [来源: ${source}], ${localNotes.length} 条本地评价`);

  // AI 分析（同时传入中文和本地评价）
  const analysis = await analyzeReviews(name, city, notes, localNotes);

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
    _debug: {
      deepseekUrl: getDeepSeekUrl(),
      hasDeepseekKey: !!process.env.DEEPSEEK_API_KEY,
      hasSerpApiKey: !!process.env.SERPAPI_KEY,
      deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "(default)",
      isVercel: !!process.env.VERCEL,
      analysisMode: analysis.analysisMode || "ai",
      noteSource: source,
      noteCount: notes.length,
      localNoteCount: localNotes.length,
    },
  };

  cache.set(cacheKey, { data: result, time: Date.now() });
  if (cache.size > 1000) { const k = cache.keys().next().value; cache.delete(k); }

  res.json(result);
};
