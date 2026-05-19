/**
 * GET /api/debug
 * 临时诊断接口 - 检查环境变量和 API 连通性
 * 部署验证完成后删除
 */
module.exports = async (req, res) => {
  const diag = {
    env: {
      SERPAPI_KEY: process.env.SERPAPI_KEY ? `已配置 (${process.env.SERPAPI_KEY.length}字符)` : "❌ 未配置",
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? `已配置 (${process.env.DEEPSEEK_API_KEY.length}字符)` : "❌ 未配置",
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || "(未设置，将使用默认值)",
      SCRAPER_URL: process.env.SCRAPER_URL || "(未设置)",
      VERCEL: process.env.VERCEL || "(未设置)",
      NODE_VERSION: process.version,
    },
    deepseekUrlBuilt: (() => {
      const base = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
      if (base.includes('/chat/completions')) return base;
      return base.replace(/\/$/, '') + '/v1/chat/completions';
    })(),
    tests: {},
  };

  // 测试 1: SerpApi 连通性
  try {
    const apiKey = process.env.SERPAPI_KEY;
    if (apiKey) {
      const url = `https://serpapi.com/search.json?engine=google_maps&q=restaurant&ll=@48.8566,2.3522,14z&api_key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      diag.tests.serpapi = {
        status: resp.status,
        hasResults: !!(data.local_results?.length),
        resultCount: data.local_results?.length || 0,
        error: data.error || null,
      };
    } else {
      diag.tests.serpapi = { error: "无 API Key" };
    }
  } catch (e) {
    diag.tests.serpapi = { error: e.message };
  }

  // 测试 2: DeepSeek 连通性
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (apiKey) {
      const resp = await fetch(diag.deepseekUrlBuilt, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "回复OK" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      diag.tests.deepseek = {
        status: resp.status,
        reply: data.choices?.[0]?.message?.content || null,
        error: data.error || null,
        rawResponse: !data.choices ? JSON.stringify(data).slice(0, 300) : undefined,
      };
    } else {
      diag.tests.deepseek = { error: "无 API Key" };
    }
  } catch (e) {
    diag.tests.deepseek = { error: e.message };
  }

  // 测试 3: SerpApi Place Detail
  try {
    const apiKey = process.env.SERPAPI_KEY;
    if (apiKey) {
      const dataParam = `!4m5!3m4!1s0x47e66facb17ca793:0x9a62171ae49b23d8!8m2!3d48.8586!4d2.3512`;
      const url = `https://serpapi.com/search.json?engine=google_maps&type=place&data=${encodeURIComponent(dataParam)}&api_key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      const pr = data.place_results || {};
      diag.tests.placeDetail = {
        status: resp.status,
        name: pr.title || null,
        rating: pr.rating || null,
        hasHours: !!(pr.hours?.length),
        hoursCount: pr.hours?.length || 0,
        hasReviews: !!(pr.user_reviews?.most_relevant?.length),
        reviewCount: pr.user_reviews?.most_relevant?.length || 0,
        error: data.error || null,
      };
    }
  } catch (e) {
    diag.tests.placeDetail = { error: e.message };
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(diag, null, 2));
};
