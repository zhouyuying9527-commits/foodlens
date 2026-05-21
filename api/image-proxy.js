/**
 * GET /api/image-proxy
 * 图片代理：解决 Google 图片在国内无法直接访问的问题
 * 用法: /api/image-proxy?url=https://lh3.googleusercontent.com/...
 */
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end('Missing url');

  // 只允许代理 Google 图片
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('googleusercontent.com') && !parsed.hostname.includes('googleapis.com')) {
      return res.status(403).end('Forbidden host');
    }
  } catch {
    return res.status(400).end('Invalid url');
  }

  // 内存缓存
  if (cache.has(url)) {
    const cached = cache.get(url);
    if (Date.now() - cached.time < CACHE_TTL) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(cached.buffer);
    }
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      return res.status(response.status).end('Upstream error');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    // 缓存（限制总大小）
    if (cache.size < 200) {
      cache.set(url, { buffer, contentType, time: Date.now() });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buffer);
  } catch (err) {
    res.status(502).end('Proxy error');
  }
};
