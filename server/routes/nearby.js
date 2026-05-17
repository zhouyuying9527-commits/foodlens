const express = require("express");
const config = require("../config");

const router = express.Router();

/**
 * GET /api/nearby
 * 通过 SerpApi 的 Google Maps 引擎搜索附近餐厅
 *
 * Query params:
 *   lat        - 纬度
 *   lng        - 经度
 *   radius     - 搜索半径（米），默认 1000
 *   minRating  - 最低评分，默认 0
 *   minReviews - 最低评论数，默认 0
 */
router.get("/nearby", async (req, res) => {
  const { lat, lng, radius = 1000, minRating = 0, minReviews = 0 } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "缺少定位参数：lat 和 lng" });
  }

  if (!config.serpapi.key) {
    console.log("[Nearby] 无 SerpApi Key，返回 Demo 数据");
    return res.json({
      restaurants: getDemoRestaurants(parseFloat(lat), parseFloat(lng), parseFloat(radius), parseFloat(minRating), parseInt(minReviews)),
      source: "demo",
    });
  }

  try {
    console.log(`[Nearby] SerpApi 搜索: lat=${lat}, lng=${lng}, radius=${radius}m`);

    // SerpApi Google Maps 搜索
    // ll 格式: @lat,lng,zoom (zoom 根据 radius 换算)
    const zoom = radiusToZoom(parseFloat(radius));
    const url = `https://serpapi.com/search.json?engine=google_maps&q=restaurant&ll=@${lat},${lng},${zoom}z&type=search&api_key=${config.serpapi.key}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("[Nearby] SerpApi 错误:", data.error);
      return res.status(502).json({ error: `SerpApi 错误: ${data.error}` });
    }

    const places = data.local_results || [];
    console.log(`[Nearby] SerpApi 返回 ${places.length} 个结果`);

    // 转换并过滤
    const userLatF = parseFloat(lat);
    const userLngF = parseFloat(lng);
    const radiusF = parseFloat(radius);

    const restaurants = places
      .map((place) => {
        const rLat = place.gps_coordinates?.latitude || userLatF;
        const rLng = place.gps_coordinates?.longitude || userLngF;
        return {
          placeId: place.place_id || place.data_id || "",
          name: place.title || "",
          rating: place.rating || 0,
          userRatingsTotal: place.reviews || 0,
          priceLevel: parsePriceLevel(place.price),
          address: place.address || "",
          lat: rLat,
          lng: rLng,
          photos: place.serpapi_thumbnail ? [place.serpapi_thumbnail] : (place.thumbnail ? [place.thumbnail] : []),
          openNow: place.open_state?.includes("Open") || null,
          types: place.type ? [place.type.toLowerCase()] : [],
          description: place.description || "",
          distance: haversineDistance(userLatF, userLngF, rLat, rLng),
        };
      })
      .filter((r) =>
        r.rating >= parseFloat(minRating) &&
        r.userRatingsTotal >= parseInt(minReviews) &&
        r.distance <= radiusF
      )
      .sort((a, b) => b.rating - a.rating);

    res.json({
      restaurants,
      total: restaurants.length,
      source: "serpapi",
    });
  } catch (err) {
    console.error("[Nearby] SerpApi 请求失败:", err.message);
    console.log("[Nearby] 降级到 Demo 数据");
    return res.json({
      restaurants: getDemoRestaurants(parseFloat(lat), parseFloat(lng), parseFloat(radius), parseFloat(minRating), parseInt(minReviews)),
      source: "demo",
      fallbackMessage: "SerpApi 暂不可用（网络限制），以下为演示数据。部署到海外服务器后自动使用真实数据。",
    });
  }
});

/**
 * Haversine 公式 - 计算两个经纬度之间的距离（米）
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径（米）
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c); // 返回距离，单位：米
}

/**
 * 搜索半径 -> Google Maps zoom level 近似转换
 */
function radiusToZoom(radiusMeters) {
  if (radiusMeters <= 500) return 16;
  if (radiusMeters <= 1000) return 15;
  if (radiusMeters <= 2000) return 14;
  if (radiusMeters <= 5000) return 13;
  return 12;
}

/**
 * 解析价格等级（$, $$, $$$, $$$$）
 */
function parsePriceLevel(price) {
  if (!price) return null;
  return (price.match(/\$/g) || []).length || null;
}

/**
 * Demo 数据
 */
function getDemoRestaurants(lat, lng, radius, minRating, minReviews) {
  const restaurants = [
    { name: "Le Comptoir de la Gastronomie", rating: 4.6, userRatingsTotal: 2847, priceLevel: 3, address: "34 Rue Montmartre, Paris", types: ["french"] },
    { name: "Chez Janou", rating: 4.5, userRatingsTotal: 3215, priceLevel: 2, address: "2 Rue Roger Verlomme, Paris", types: ["french"] },
    { name: "Breizh Café", rating: 4.7, userRatingsTotal: 1893, priceLevel: 2, address: "109 Rue Vieille du Temple, Paris", types: ["french"] },
    { name: "Kodawari Ramen", rating: 4.8, userRatingsTotal: 4521, priceLevel: 2, address: "29 Rue Mazarine, Paris", types: ["japanese"] },
    { name: "Pink Mamma", rating: 4.2, userRatingsTotal: 8932, priceLevel: 2, address: "20bis Rue de Douai, Paris", types: ["italian"] },
    { name: "Bouillon Chartier", rating: 4.1, userRatingsTotal: 12453, priceLevel: 1, address: "7 Rue du Faubourg Montmartre, Paris", types: ["french"] },
    { name: "Sushi Okuda", rating: 4.9, userRatingsTotal: 523, priceLevel: 4, address: "18 Rue de l'Échiquier, Paris", types: ["japanese"] },
  ];

  const radiusDeg = radius / 111000;
  return restaurants
    .map((r, i) => ({ ...r, placeId: `demo_${i}`, lat: lat + (Math.random() - 0.5) * radiusDeg * 2, lng: lng + (Math.random() - 0.5) * radiusDeg * 2, photos: [], openNow: true }))
    .filter((r) => r.rating >= minRating && r.userRatingsTotal >= minReviews)
    .sort((a, b) => b.rating - a.rating);
}

module.exports = router;
