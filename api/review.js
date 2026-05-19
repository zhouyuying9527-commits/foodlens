/**
 * GET /api/review
 * 小红书评价 + AI 分析
 * Vercel Serverless Function
 *
 * 流程：
 * 1. DeepSeek 生成搜索关键词
 * 2. 调 Fly.io 爬虫服务获取真实小红书笔记
 * 3. DeepSeek 分析笔记
 */

const cache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Demo 笔记（爬虫服务不可用时的降级）
function getDemoNotes(keyword) {
  return [
    { title: `${keyword} 实测分享｜值得专门去一趟`, desc: "环境很好，服务态度也不错。菜品口味偏清淡，适合不太能吃辣的朋友。人均大概300人民币左右。推荐他家的招牌菜，分量很足。", likes: "2.3k", author: "吃货小王", keyword },
    { title: `${keyword}｜排队2小时值不值？`, desc: "味道确实不错，但排队时间太长了。建议工作日去。点了招牌套餐，够两个人吃。服务员会说英文。", likes: "1.8k", author: "旅行日记", keyword },
    { title: `带爸妈去${keyword}，适合中国胃吗？`, desc: "带爸妈来的，老人家吃得挺开心。菜的口味不会太奇怪也不会太油腻。有热汤这点很加分。人均200-250人民币。", likes: "1.2k", author: "孝顺旅行者", keyword },
  ];
}

// DeepSeek 关键词生成
async function generateKeywords(name, city) {
  try {
    const prompt = `你是小红书搜索优化助手。餐厅原名：${name}，城市：${city}。生成2-3个搜索关键词，必须包含完整餐厅原名。返回JSON数组。`;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return [name, `${name} ${city}`];

    const response = await fetch(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 150 }),
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) return JSON.parse(match[0]);
  } catch (e) { /* ignore */ }
  return [name, `${name} ${city}`];
}

// DeepSeek 评价分析
async function analyzeReviews(restaurantName, city, notes) {
  try {
    const notesText = notes.map((n, i) => `[${i + 1}] 标题：${n.title}\n内容：${n.desc}`).join("\n\n");
    const prompt = `你是帮助中国游客做海外餐厅决策的AI。目标餐厅：「${restaurantName}」（${city}）\n笔记：\n${notesText}\n\n请按JSON输出：{"relevantNoteCount":3,"rating":"recommend","summary":"一句话总结","chineseStomachIndex":{"score":4,"reason":"实质口味描述，禁止出现笔记[1]等指代"},"recommendedDishes":[{"name":"菜名","reason":"实质推荐理由，禁止笔记[1]提及类废话"}],"needReservation":"需要提前预约","pros":["..."],"cons":["..."],"practicalInfo":{"avgPrice":"...","waitTime":"...","paymentMethod":"...","tips":"..."},"adCount":0,"confidence":"high"}`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return fallbackAnalyze(notes);

    const response = await fetch(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 1000 }),
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      result.noteCount = notes.length;
      return result;
    }
  } catch (e) { /* ignore */ }
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

// 调 Fly.io 爬虫服务
async function fetchXhsNotes(keywords) {
  const scraperUrl = process.env.SCRAPER_URL;
  if (!scraperUrl) {
    console.log("[Vercel Review] 无爬虫服务地址，使用 demo 数据");
    return { notes: getDemoNotes(keywords[0]), fallback: true, message: "小红书爬虫服务未部署，当前为示例数据" };
  }

  try {
    const response = await fetch(`${scraperUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords, maxResults: 15 }),
      signal: AbortSignal.timeout(30000), // 30秒超时
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.notes && data.notes.length > 0) {
      console.log(`[Vercel Review] 爬虫返回 ${data.notes.length} 条笔记 (${data.elapsedMs}ms)`);
      return { notes: data.notes, fallback: false, message: null };
    }

    console.log("[Vercel Review] 爬虫无结果，降级 demo");
    return { notes: getDemoNotes(keywords[0]), fallback: true, message: "该餐厅暂未采集到小红书笔记" };
  } catch (err) {
    console.log(`[Vercel Review] 爬虫服务不可用: ${err.message}，降级 demo`);
    return { notes: getDemoNotes(keywords[0]), fallback: true, message: "爬虫服务暂不可用，当前为示例数据" };
  }
}

module.exports = async (req, res) => {
  const { name, city = "Paris" } = req.query;
  if (!name) return res.status(400).json({ error: "缺少餐厅名称" });

  const cacheKey = `${name}-${city}`;
  if (cache.has(cacheKey) && Date.now() - cache.get(cacheKey).time < CACHE_TTL) {
    return res.json(cache.get(cacheKey).data);
  }

  const start = Date.now();
  console.log(`[Vercel Review] 开始处理: ${name} (${city})`);

  // 关键词生成
  const keywords = await generateKeywords(name, city);
  console.log(`[Vercel Review] 关键词: ${keywords.join(", ")}`);

  // 小红书采集（优先爬虫，降级 demo）
  const { notes, fallback, message } = await fetchXhsNotes(keywords);
  console.log(`[Vercel Review] 采集到 ${notes.length} 条笔记${fallback ? " (demo)" : " (real)"}`);

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
    dataSource: fallback ? "demo" : "xiaohongshu",
    dataSourceMessage: fallback && message ? message : null,
  };

  cache.set(cacheKey, { data: result, time: Date.now() });
  if (cache.size > 1000) { const k = cache.keys().next().value; cache.delete(k); }

  res.json(result);
};
