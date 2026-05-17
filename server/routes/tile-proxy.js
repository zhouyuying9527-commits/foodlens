const express = require("express");
const https = require("https");
const router = express.Router();

/**
 * 瓦片代理路由
 * 解决国内无法直接访问 CartoDB / OSM 瓦片的问题
 * 浏览器请求 /tiles/{z}/{x}/{y} → 服务器代理获取 → 返回瓦片图片
 */

// 瓦片源列表，按优先级尝试
const TILE_SOURCES = [
  {
    name: "CartoDB Voyager",
    url: (z, x, y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  },
  {
    name: "CartoDB Positron",
    url: (z, x, y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  },
  {
    name: "OSM",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
];

// 简单内存缓存
const tileCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

function fetchTile(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "FoodLens/1.0",
          Accept: "image/png,image/*",
        },
        timeout,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

router.get("/tiles/:z/:x/:y", async (req, res) => {
  const { z, x, y } = req.params;
  const cacheKey = `${z}/${x}/${y}`;

  // 检查缓存
  const cached = tileCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Tile-Source", "cache");
    return res.send(cached.data);
  }

  // 逐个尝试瓦片源
  for (const source of TILE_SOURCES) {
    try {
      const url = source.url(z, x, y);
      const data = await fetchTile(url);

      // 缓存成功的瓦片
      tileCache.set(cacheKey, { data, time: Date.now() });

      // 限制缓存大小（最多 2000 张瓦片）
      if (tileCache.size > 2000) {
        const firstKey = tileCache.keys().next().value;
        tileCache.delete(firstKey);
      }

      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.set("X-Tile-Source", source.name);
      return res.send(data);
    } catch (e) {
      // 继续尝试下一个源
    }
  }

  // 全部失败 → 返回一个1x1透明PNG
  const emptyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==",
    "base64"
  );
  res.set("Content-Type", "image/png");
  res.set("X-Tile-Source", "fallback-empty");
  res.status(200).send(emptyPng);
});

module.exports = router;
