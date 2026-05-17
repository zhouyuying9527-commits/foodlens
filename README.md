# 食探 FoodLens

为海外中国游客打造的餐厅发现工具：Google Maps 实时定位 + 小红书口碑分析。

## 本地开发

```bash
npm install
cp .env.example .env  # 填入你的 API Key
node server/index.js
# 访问 http://localhost:3000
```

## 部署到 Vercel

1. 将代码推送到 GitHub
2. 在 [Vercel](https://vercel.com) 导入此仓库
3. 添加以下环境变量：
   - `SERPAPI_KEY` — Google Maps 数据源
   - `DEEPSEEK_API_KEY` — AI 分析
   - `DEEPSEEK_BASE_URL` — `https://api.deepseek.com`
4. 一键部署完成

## 技术栈

- **前端**: Leaflet + 原生 HTML/CSS/JS
- **后端**: Node.js + Express（本地）/ Vercel Serverless（线上）
- **数据源**: SerpApi（Google Maps）、小红书（Playwright 采集 + Cookie 登录）
- **AI**: DeepSeek（关键词生成 + 评价分析）
