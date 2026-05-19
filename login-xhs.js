const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const cookiesPath = path.join(__dirname, 'server', 'cookies', 'xhs-cookies.json');
  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
  const now = Date.now() / 1000;
  const validCookies = cookies.filter(c => !c.expires || c.expires === -1 || c.expires === 0 || c.expires > now);

  const browser = await chromium.launch({ headless: false }); // visible for login
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  console.log('正在打开小红书登录页...');
  console.log('请在浏览器中完成登录（扫码或手机号）');
  console.log('登录成功后会自动保存 cookies\n');

  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 等待用户登录（最多等 120 秒）
  let loggedIn = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    // 检查是否出现已登录的标志（如个人头像、创作中心等）
    const loginModal = await page.$('[class*="login-modal"], [class*="qr-code"]');
    const hasAvatar = await page.$('[class*="user-avatar"], [class*="avatar-component"]');
    if (hasAvatar && !loginModal) {
      loggedIn = true;
      break;
    }
    if (i % 5 === 0) console.log(`等待登录中... (${i * 2}s)`);
  }

  if (loggedIn) {
    // 保存 cookies
    const freshCookies = await context.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(freshCookies, null, 2));
    console.log(`\n✅ 登录成功！已保存 ${freshCookies.length} 个 cookies`);
    console.log('文件: ' + cookiesPath);

    // 验证搜索功能
    console.log('\n正在验证搜索功能...');
    await page.goto('https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent('巴黎美食') + '&source=web_search_result_notes', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
    if (text.includes('登录后查看')) {
      console.log('⚠️ 搜索结果仍需登录，可能需要滑块验证');
    } else {
      console.log('✅ 搜索功能正常');
    }
  } else {
    console.log('\n❌ 登录超时（120秒）');
  }

  await browser.close();
})().catch(e => console.error('Error:', e.message));
