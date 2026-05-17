const express = require("express");
const scraper = require("../services/scraper");
const ai = require("../services/ai");

const router = express.Router();

// 简易内存缓存（生产环境应改为 Redis）
const cache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

/**
 * GET /api/review
 * 查询餐厅的小红书评价摘要
 *
 * Query params:
 *   name     - 餐厅名称（必填）
 *   city     - 城市名称（必填）
 *   cuisine  - 菜系类型（选填）
 */
router.get("/review", async (req, res) => {
  const { name, city, cuisine, demo } = req.query;

  if (!name || !city) {
    return res.status(400).json({ error: "缺少必填参数：name 和 city" });
  }

  const cacheKey = `${name}|${city}|${cuisine || ""}`;

  // 检查缓存
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`[API] 缓存命中: ${cacheKey}`);
      return res.json({ ...cached.data, cached: true });
    }
    cache.delete(cacheKey);
  }

  try {
    console.log(`[API] 开始处理: ${name} (${city})`);
    const startTime = Date.now();

    // Step 1: AI 生成搜索关键词
    console.log("[API] Step 1: 生成搜索关键词...");
    const keywords = await ai.generateKeywordsWithFallback(name, city, cuisine);
    console.log(`[API] 关键词: ${keywords.join(", ")}`);

    // Step 2: 获取小红书数据（demo模式跳过真实采集）
    console.log("[API] Step 2: 获取小红书数据...");
    let notes, fallback, message;
    if (demo === "true") {
      // Demo 模式：直接用降级数据，不走 Playwright
      const demoData = scraper._getDemoNotes(keywords[0] || name);
      notes = demoData;
      fallback = true;
      message = "Demo 模式：使用示例数据展示效果";
      console.log("[API] Demo 模式，使用示例数据");
    } else {
      ({ notes, fallback, message } = await scraper.searchWithFallback(keywords, 15));
    }

    if (fallback && notes.length === 0) {
      // 完全没有数据，直接返回提示
      return res.json({
        restaurant: { name, city, cuisine },
        rating: "unknown",
        summary: message,
        pros: [],
        cons: [],
        practicalInfo: {},
        noteCount: 0,
        keywords,
        elapsedMs: Date.now() - startTime,
      });
    }

    console.log(`[API] 采集到 ${notes.length} 条笔记`);

    // Step 3: AI 分析评价（带降级）
    console.log("[API] Step 3: AI 分析评价...");
    const analysis = await ai.analyzeReviewsWithFallback(name, city, notes);

    const result = {
      restaurant: { name, city, cuisine },
      ...analysis,
      keywords,
      rawNotes: notes.slice(0, 5).map((n) => ({ title: n.title, desc: n.desc?.slice(0, 100), likes: n.likes, link: n.link || "" })),
      elapsedMs: Date.now() - startTime,
      cached: false,
      dataSource: fallback ? "demo" : "xiaohongshu",
      dataSourceMessage: fallback ? message : null,
    };

    // 写入缓存
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`[API] 完成，耗时 ${result.elapsedMs}ms`);

    res.json(result);
  } catch (err) {
    console.error("[API] 处理错误:", err);
    res.status(500).json({ error: "服务处理异常", detail: err.message });
  }
});

/**
 * GET /api/health
 * 健康检查
 */
router.get("/health", (req, res) => {
  res.json({ status: "ok", cacheSize: cache.size });
});

module.exports = router;
