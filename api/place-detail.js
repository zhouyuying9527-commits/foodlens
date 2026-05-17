/**
 * GET /api/place-detail
 * SerpApi Place Details
 * Vercel Serverless Function
 */
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) return res.status(400).json({ error: "缺少 placeId" });

  if (cache.has(placeId) && Date.now() - cache.get(placeId).time < CACHE_TTL) {
    return res.json(cache.get(placeId).data);
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.json({ error: "无 SerpApi Key" });

  try {
    const url = `https://serpapi.com/search.json?engine=google_maps_place&data_id=${placeId}&api_key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) return res.status(502).json({ error: data.error });

    const result = {
      name: data.title || "",
      openState: data.open_state || "",
      hours: (data.hours || []).map((h) => ({
        day: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][h.day] || `周${h.day}`,
        hours: h.hours || "",
      })),
      address: data.address || "",
      phone: data.phone || "",
      website: data.website || "",
      priceLevel: data.price_range || "",
      photos: (data.photos || []).slice(0, 8).map((p) => p.serpapi_thumbnail || p.thumbnail || "").filter(Boolean),
      googleReviews: (data.user_reviews || []).slice(0, 10).map((r) => ({
        author: r.user?.name || "",
        rating: r.rating || 0,
        text: r.snippet || "",
        date: r.date || "",
      })),
    };

    cache.set(placeId, { data: result, time: Date.now() });
    if (cache.size > 500) { const k = cache.keys().next().value; cache.delete(k); }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "POI 详情获取失败", detail: err.message });
  }
};
