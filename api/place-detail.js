/**
 * GET /api/place-detail
 * SerpApi Google Maps 店铺详情
 * Vercel Serverless Function
 */
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  const { placeId, dataId, lat, lng } = req.query;

  const id = dataId || placeId;
  if (!id) return res.status(400).json({ error: "缺少 placeId 或 dataId" });

  const cacheKey = id;
  if (cache.has(cacheKey) && Date.now() - cache.get(cacheKey).time < CACHE_TTL) {
    return res.json(cache.get(cacheKey).data);
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: "未配置 SERPAPI_KEY" });

  try {
    // 使用正确的 SerpApi place detail 调用方式
    const dataParam = `!4m5!3m4!1s${id}!8m2!3d${lat || 48.8566}!4d${lng || 2.3522}`;
    const url = `https://serpapi.com/search.json?engine=google_maps&type=place&data=${encodeURIComponent(dataParam)}&api_key=${apiKey}`;

    console.log(`[PlaceDetail] 请求: id=${id}, lat=${lat}, lng=${lng}`);

    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) {
      console.log(`[PlaceDetail] SerpApi HTTP ${response.status}`);
      return res.status(502).json({ error: `SerpApi HTTP ${response.status}` });
    }
    const data = await response.json();

    if (data.error) {
      console.log(`[PlaceDetail] SerpApi error: ${data.error}`);
      return res.status(502).json({ error: data.error });
    }

    const pr = data.place_results || {};

    const result = {
      name: pr.title || "",
      rating: pr.rating || 0,
      totalReviews: pr.reviews || 0,
      openState: pr.open_state || "",
      hours: (pr.hours || []).map((item) => {
        const [day, hours] = Object.entries(item)[0] || [];
        return {
          day: { monday: "周一", tuesday: "周二", wednesday: "周三", thursday: "周四", friday: "周五", saturday: "周六", sunday: "周日" }[day] || day,
          hours: hours || "",
        };
      }),
      address: pr.address || "",
      phone: pr.phone || "",
      website: pr.website || "",
      priceLevel: pr.price || "",
      photos: (pr.images || []).slice(0, 8).map((p) => p.thumbnail || "").filter(Boolean),
      googleReviews: ((pr.user_reviews?.most_relevant) || []).slice(0, 10).map((r) => ({
        author: r.username || "",
        rating: r.rating || 0,
        text: r.description || "",
        date: r.date || "",
      })),
    };

    cache.set(cacheKey, { data: result, time: Date.now() });
    if (cache.size > 500) { const k = cache.keys().next().value; cache.delete(k); }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "POI 详情获取失败", detail: err.message });
  }
};
