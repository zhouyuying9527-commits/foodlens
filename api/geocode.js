/**
 * GET /api/geocode
 * 城市地理编码：
 *   正向: /api/geocode?q=巴厘岛 → 返回 results: [{name, address, lat, lng}]
 *   反向: /api/geocode?lat=-8.65&lng=115.14 → 返回 { city, country, address, lat, lng }
 */
module.exports = async (req, res) => {
  const { q, lat, lng } = req.query;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: "未配置 SERPAPI_KEY" });

  // ---------- 反向地理编码 ----------
  if (lat && lng) {
    try {
      // 用 google_maps engine + ll 参数反查附近地标，从地址里提取城市
      const url = `https://serpapi.com/search.json?engine=google_maps&q=restaurant&ll=@${lat},${lng},14z&type=search&api_key=${apiKey}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return res.status(502).json({ error: "反向地理编码失败" });
      const d = await r.json();

      const addresses = [];
      if (d.local_results) {
        for (const item of d.local_results.slice(0, 5)) {
          if (item.address) addresses.push(item.address);
        }
      }
      if (d.place_results?.address) addresses.push(d.place_results.address);

      // 从地址中提取最常见的城市名
      // 地址通常形如 "Jl. ..., Canggu, Kabupaten Badung, Bali 80361, Indonesia"
      // 取倒数第二段（国家前一段）作为城市/地区
      const cityCounter = {};
      const countryCounter = {};
      for (const addr of addresses) {
        const parts = addr.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const country = parts[parts.length - 1].replace(/\d+/g, "").trim();
          countryCounter[country] = (countryCounter[country] || 0) + 1;
          // 优先取倒数第二段（去掉邮编数字）
          const cityCandidate = parts[parts.length - 2].replace(/\d+/g, "").trim();
          if (cityCandidate) cityCounter[cityCandidate] = (cityCounter[cityCandidate] || 0) + 1;
          // 也统计倒数第三段（有时 city 在更前面）
          if (parts.length >= 3) {
            const c2 = parts[parts.length - 3].replace(/\d+/g, "").trim();
            if (c2) cityCounter[c2] = (cityCounter[c2] || 0) + 0.5;
          }
        }
      }

      const topCity = Object.entries(cityCounter).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      const topCountry = Object.entries(countryCounter).sort((a, b) => b[1] - a[1])[0]?.[0] || "";

      return res.json({
        city: topCity,
        country: topCountry,
        address: addresses[0] || "",
        lat: parseFloat(lat),
        lng: parseFloat(lng),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ---------- 正向地理编码 ----------
  if (!q) return res.status(400).json({ error: "缺少查询参数 q" });

  try {
    const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(q)}&type=search&api_key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(502).json({ error: "搜索失败" });

    const data = await response.json();

    // 从 place_results 或 local_results 提取位置
    const results = [];

    if (data.place_results) {
      const pr = data.place_results;
      if (pr.gps_coordinates) {
        results.push({
          name: pr.title || q,
          address: pr.address || "",
          lat: pr.gps_coordinates.latitude,
          lng: pr.gps_coordinates.longitude,
        });
      }
    }

    if (data.local_results) {
      for (const r of data.local_results.slice(0, 3)) {
        if (r.gps_coordinates) {
          results.push({
            name: r.title || "",
            address: r.address || "",
            lat: r.gps_coordinates.latitude,
            lng: r.gps_coordinates.longitude,
          });
        }
      }
    }

    // 如果 Google Maps 没有结果，用搜索信息中的坐标
    if (results.length === 0 && data.search_information?.organic_results_state) {
      // 尝试从 serpapi 的 search_metadata 获取
    }

    // 兜底：用 Google 普通搜索获取坐标
    if (results.length === 0) {
      const geoUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q + " coordinates")}&api_key=${apiKey}`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        // 从 knowledge_graph 或 answer_box 提取
        const kg = geoData.knowledge_graph;
        if (kg && kg.latitude && kg.longitude) {
          results.push({
            name: kg.title || q,
            address: kg.description || "",
            lat: parseFloat(kg.latitude),
            lng: parseFloat(kg.longitude),
          });
        }
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
