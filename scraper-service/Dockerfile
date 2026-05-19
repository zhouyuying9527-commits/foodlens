FROM node:20-slim

# 安装 Playwright 依赖
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install
RUN npx playwright install chromium

COPY server.js ./
# cookies.json 通过 API 上传或 volume 挂载

EXPOSE 3000
CMD ["node", "server.js"]
