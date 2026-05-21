/**
 * GET /api/test-image
 * 诊断：Vercel 服务器能否访问 Google 图片
 */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const testUrl = req.query.url ||
    'https://lh3.googleusercontent.com/gps-cs-s/APNQkAFvdLrN9B1b3F43QDpVarqa6iZk1LySNRwsldD2uUbHFnTp1b0Fd0bcvmMjAWSW9rdnB27Fq';

  const result = { url: testUrl };

  try {
    const t0 = Date.now();
    const response = await fetch(testUrl, {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
        'Referer': 'https://www.google.com/',
      },
    });
    result.elapsedMs = Date.now() - t0;
    result.status = response.status;
    result.contentType = response.headers.get('content-type');
    result.contentLength = response.headers.get('content-length');
    result.finalUrl = response.url;
    result.ok = response.ok;
    if (response.ok) {
      const buf = await response.arrayBuffer();
      result.bytesReceived = buf.byteLength;
    }
  } catch (e) {
    result.error = e.name + ': ' + e.message;
  }

  res.end(JSON.stringify(result, null, 2));
};
