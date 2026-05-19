#!/bin/bash
# 将本地 cookies 上传到 Fly.io 爬虫服务
# 用法: ./upload-cookies.sh

SCRAPER_URL="${SCRAPER_URL:-https://foodlens-xhs-scraper.fly.dev}"
COOKIES_FILE="../server/cookies/xhs-cookies.json"

if [ ! -f "$COOKIES_FILE" ]; then
  echo "❌ 找不到 cookies 文件: $COOKIES_FILE"
  echo "   请先运行 node login-xhs.js 登录小红书"
  exit 1
fi

echo "📤 正在上传 cookies 到 $SCRAPER_URL ..."
RESPONSE=$(curl -s -X POST "$SCRAPER_URL/api/update-cookies" \
  -H "Content-Type: application/json" \
  -d @"$COOKIES_FILE")

echo "✅ 服务器返回: $RESPONSE"
