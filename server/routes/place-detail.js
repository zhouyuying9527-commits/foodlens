const express = require("express");
const config = require("../config");

const router = express.Router();

// 内存缓存 POI 详情（避免重复请求 SerpApi）
const poiCache = new Map();
const POI_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

/**
 * GET /api/place-detail
 * 通过 SerpApi 的 Google Maps Place Details 获取 POI 完整信息
 *
 * Query params:
 *   placeId  - Google Maps place_id
 *   dataId   - SerpApi data_id (备用)
 */
router.get("/place-detail", async (req, res) => {
  const { placeId, dataId } = req.query;

  if (!placeId && !dataId) {
    return res.status(400).json({ error: "缺少 placeId 或 dataId 参数" });
  }

  const cacheKey = placeId || dataId;

  // 检查缓存
  if (poiCache.has(cacheKey)) {
    const cached = poiCache.get(cacheKey);
    if (Date.now() - cached.timestamp < POI_CACHE_TTL) {
      console.log(`[PlaceDetail] 缓存命中: ${cacheKey}`);
      return res.json(cached.data);
    }
    poiCache.delete(cacheKey);
  }

  if (!config.serpapi.key) {
    return res.status(503).json({ error: "未配置 SerpApi Key" });
  }

  try {
    console.log(`[PlaceDetail] 查询: ${cacheKey}`);

    // SerpApi Google Maps Place Details
    const params = new URLSearchParams({
      engine: "google_maps",
      type: "place",
      api_key: config.serpapi.key,
    });

    if (placeId) {
      params.set("place_id", placeId);
    } else {
      params.set("data_id", dataId);
    }

    const url = `https://serpapi.com/search.json?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("[PlaceDetail] SerpApi 错误:", data.error);
      return res.status(502).json({ error: `SerpApi 错误: ${data.error}` });
    }

    const place = data.place_results || {};

    // 提取结构化信息
    const result = {
      name: place.title || "",
      address: place.address || "",
      phone: place.phone || "",
      website: place.website || "",
      rating: place.rating || 0,
      reviewCount: place.reviews || 0,
      priceLevel: place.price || "",
      type: place.type || "",
      description: place.description || "",

      // 营业状态
      openState: place.open_state || "",
      hours: extractHours(place.hours),

      // 图片
      photos: extractPhotos(place.images || [], 6),

      // Google 评论
      googleReviews: extractGoogleReviews(place.user_reviews?.most_relevant || [], 5),

      // 原始数据补充
      gpsCoordinates: place.gps_coordinates || null,
      dataId: place.data_id || dataId || "",
    };

    // 缓存
    poiCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`[PlaceDetail] 完成: ${result.name} | ${result.openState} | ${result.photos.length} photos`);

    res.json(result);
  } catch (err) {
    console.error("[PlaceDetail] 请求失败:", err);
    res.status(500).json({ error: "获取餐厅详情失败", detail: err.message });
  }
});

/**
 * 提取营业时间
 * SerpApi 格式: [{"thursday": "7 AM–2 AM"}, {"friday": "7 AM–2 AM"}, ...]
 */
function extractHours(hours) {
  if (!hours) return null;

  if (Array.isArray(hours)) {
    return hours.map((h) => {
      if (typeof h === "object") {
        const [day, time] = Object.entries(h)[0] || ["", ""];
        return { day: capitalizeDay(day), hours: time };
      }
      return { day: "", hours: String(h) };
    }).filter((h) => h.day);
  }

  if (typeof hours === "object") {
    return Object.entries(hours).map(([day, time]) => ({
      day: capitalizeDay(day),
      hours: typeof time === "string" ? time : (time?.join?.(", ") || ""),
    }));
  }

  return null;
}

function capitalizeDay(day) {
  if (!day) return "";
  const dayMap = { monday: "周一", tuesday: "周二", wednesday: "周三", thursday: "周四", friday: "周五", saturday: "周六", sunday: "周日" };
  return dayMap[day.toLowerCase()] || day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * 提取图片 URL
 * 优先使用 serpapi_thumbnail（代理 URL，国内可访问）
 * SerpApi 格式: [{title, thumbnail, serpapi_thumbnail}, ...]
 */
function extractPhotos(photos, max) {
  if (!photos || !Array.isArray(photos)) return [];

  return photos.slice(0, max).map((p) => {
    if (typeof p === "string") return p;
    // 优先用 serpapi 代理的 thumbnail（国内可访问）
    return p.serpapi_thumbnail || p.image || p.thumbnail || p.src || "";
  }).filter(Boolean);
}

/**
 * 提取 Google 用户评论
 * SerpApi 格式: [{username: "...", rating: 5, description: "...", date: "..."}, ...]
 */
function extractGoogleReviews(reviews, max) {
  if (!reviews || !Array.isArray(reviews)) return [];

  return reviews.slice(0, max).map((r) => ({
    author: r.username || r.user?.name || r.author || "",
    rating: r.rating || 0,
    text: r.description || r.snippet || r.extracted_snippet?.original || r.text || "",
    date: r.date || "",
    language: r.language || "",
  }));
}

module.exports = router;
