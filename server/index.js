const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("./config");
const reviewRoutes = require("./routes/review");
const nearbyRoutes = require("./routes/nearby");
const placeDetailRoutes = require("./routes/place-detail");
const tileProxyRoutes = require("./routes/tile-proxy");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

// API 路由
app.use("/api", reviewRoutes);
app.use("/api", nearbyRoutes);
app.use("/api", placeDetailRoutes);
app.use("/", tileProxyRoutes);

// 前端配置（不暴露敏感 key）
app.get("/api/config", (req, res) => {
  res.json({ hasSerpApi: !!config.serpapi.key });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

app.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  🍜 食探 FoodLens - MVP Server          ║
  ║  http://localhost:${config.port}                  ║
  ╚══════════════════════════════════════════╝
  `);
  if (!config.deepseek.apiKey || config.deepseek.apiKey === "your_key_here")
    console.warn("  ⚠️  未配置 DEEPSEEK_API_KEY");
  if (!config.serpapi.key)
    console.warn("  ⚠️  未配置 SERPAPI_KEY（餐厅搜索将使用 Demo 模式）");
});

process.on("SIGINT", async () => {
  const scraper = require("./services/scraper");
  await scraper.close();
  process.exit(0);
});
