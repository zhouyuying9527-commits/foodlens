/**
 * GET /api/image-proxy
 * 图片代理：解决 Google 图片在国内无法直接访问的问题
 * 用法: /api/image-proxy?url=https://lh3.googleusercontent.com/...
 */
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

const ALLOWED_HOSTS = [
  'googleusercontent.com',
  'googleapis.com',
  'ggpht.com',           // 也是 Google 用户内容
  'gstatic.com',
  'google.com',
  'serpapi.com',         // 兜底
];

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;
  if (!url) return res.status(400).end('Missing url');

  // 域名白名单
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).end('Invalid url');
  }
  const ok = ALLOWED_HOSTS.some(h => parsed.hostname.endsWith(h));
  if (!ok) {
    return res.status(403).end('Forbidden host: ' + parsed.hostname);
  }

  // 内存缓存
  if (cache.has(url)) {
    const cached = cache.get(url);
    if (Date.now() - cached.time < CACHE_TTL) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Cache', 'HIT');
      return res.end(cached.buffer);
    }
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/',
      },
    });

    if (!response.ok) {
      console.log(`[image-proxy] upstream ${response.status} for ${url.slice(0, 80)}`);
      return res.status(response.status).end(`Upstream ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    // 限制单图大小（5MB），避免缓存爆掉
    if (buffer.length < 5 * 1024 * 1024 && cache.size < 200) {
      cache.set(url, { buffer, contentType, time: Date.now() });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Cache', 'MISS');
    res.end(buffer);
  } catch (err) {
    console.log(`[image-proxy] error: ${err.message} for ${url.slice(0, 80)}`);
    res.status(502).end('Proxy error: ' + err.message);
  }
};
