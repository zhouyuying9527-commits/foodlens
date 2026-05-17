FROM node:20-slim

# 安装 Playwright 依赖
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npx playwright install chromium

EXPOSE 3000
CMD ["node", "index.js"]
