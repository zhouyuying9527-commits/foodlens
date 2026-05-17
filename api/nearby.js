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
  return (price.match(/\$/g) || []).length || null;
}

function getDemoRestaurants(lat, lng, radius, minRating, minReviews) {
  const restaurants = [
    { name: "Le Comptoir de la Gastronomie", rating: 4.6, userRatingsTotal: 2847, priceLevel: 3, address: "34 Rue Montmartre, Paris", types: ["french"] },
    { name: "Breizh Café", rating: 4.7, userRatingsTotal: 1893, priceLevel: 2, address: "109 Rue Vieille du Temple, Paris", types: ["french"] },
    { name: "Kodawari Ramen", rating: 4.8, userRatingsTotal: 4521, priceLevel: 2, address: "29 Rue Mazarine, Paris", types: ["japanese"] },
    { name: "Pink Mamma", rating: 4.2, userRatingsTotal: 8932, priceLevel: 2, address: "20bis Rue de Douai, Paris", types: ["italian"] },
    { name: "Bouillon Chartier", rating: 4.1, userRatingsTotal: 12453, priceLevel: 1, address: "7 Rue du Faubourg Montmartre, Paris", types: ["french"] },
  ];
  const radiusDeg = radius / 111000;
  return restaurants
    .map((r, i) => ({ ...r, placeId: `demo_${i}`, lat: lat + (Math.random() - 0.5) * radiusDeg * 2, lng: lng + (Math.random() - 0.5) * radiusDeg * 2, photos: [], openNow: true }))
    .filter((r) => r.rating >= minRating && r.userRatingsTotal >= minReviews)
    .sort((a, b) => b.rating - a.rating);
}

module.exports = async (req, res) => {
  const { lat, lng, radius = 1000, minRating = 0, minReviews = 0 } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "缺少定位参数：lat 和 lng" });
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return res.json({ restaurants: getDemoRestaurants(parseFloat(lat), parseFloat(lng), parseFloat(radius), parseFloat(minRating), parseInt(minReviews)), source: "demo" });
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
          placeId: place.place_id || place.data_id || "",
          name: place.title || "",
          rating: place.rating || 0,
          userRatingsTotal: place.reviews || 0,
          priceLevel: parsePriceLevel(place.price),
          address: place.address || "",
          lat: rLat, lng: rLng,
          photos: place.serpapi_thumbnail ? [place.serpapi_thumbnail] : (place.thumbnail ? [place.thumbnail] : []),
          openNow: place.open_state?.includes("Open") || null,
          types: place.type ? [place.type.toLowerCase()] : [],
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
