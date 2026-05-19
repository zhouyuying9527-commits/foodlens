/**
 * GET /api/nearby
 * SerpApi Google Maps 附近餐厅搜索
 * Vercel Serverless Function
 */

/**
 * Haversine 公式
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function radiusToZoom(radiusMeters) {
  if (radiusMeters <= 500) return 16;
  if (radiusMeters <= 1000) return 15;
  if (radiusMeters <= 2000) return 14;
  if (radiusMeters <= 5000) return 13;
  return 12;
}

function parsePriceLevel(price) {
  if (!price) return null;
  const symbols = (price.match(/[\$€£]/g) || []).length;
  return symbols || null;
}

module.exports = async (req, res) => {
  const { lat, lng, radius = 1000, minRating = 0, minReviews = 0 } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "缺少定位参数：lat 和 lng" });
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "未配置 SERPAPI_KEY 环境变量" });
  }

  try {
    const zoom = radiusToZoom(parseFloat(radius));
    const url = `https://serpapi.com/search.json?engine=google_maps&q=restaurant&ll=@${lat},${lng},${zoom}z&type=search&api_key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      return res.status(502).json({ error: `SerpApi 错误: ${data.error}` });
    }

    const places = data.local_results || [];
    const userLatF = parseFloat(lat);
    const userLngF = parseFloat(lng);
    const radiusF = parseFloat(radius);

    const restaurants = places
      .map((place) => {
        const rLat = place.gps_coordinates?.latitude || userLatF;
        const rLng = place.gps_coordinates?.longitude || userLngF;
        return {
          placeId: place.place_id || "",
          dataId: place.data_id || "",
          name: place.title || "",
          rating: place.rating || 0,
          userRatingsTotal: place.reviews || 0,
          priceLevel: parsePriceLevel(place.price),
          price: place.price || "",
          address: place.address || "",
          lat: rLat,
          lng: rLng,
          photos: place.thumbnail ? [place.thumbnail] : [],
          openNow: place.open_state ? !place.open_state.toLowerCase().includes("closed") : null,
          openState: place.open_state || "",
          operatingHours: place.operating_hours || null,
          types: place.types || (place.type ? [place.type] : ["Restaurant"]),
          distance: haversineDistance(userLatF, userLngF, rLat, rLng),
        };
      })
      .filter((r) => r.rating >= parseFloat(minRating) && r.userRatingsTotal >= parseInt(minReviews) && r.distance <= radiusF)
      .sort((a, b) => b.rating - a.rating);

    res.json({ restaurants, total: restaurants.length, source: "serpapi" });
  } catch (err) {
    res.status(500).json({ error: "搜索附近餐厅失败", detail: err.message });
  }
};
