/**
 * 小红书登录脚本
 * 运行后会打开浏览器窗口，扫码登录后自动保存 Cookie
 * 
 * 使用方式: node server/login-xhs.js
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const COOKIE_PATH = path.join(__dirname, "cookies", "xhs-cookies.json");

async function login() {
  // 确保 cookies 目录存在
  const cookieDir = path.dirname(COOKIE_PATH);
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  console.log("🔐 正在打开小红书登录页面...");
  console.log("   请在浏览器中扫码或手机号登录");
  console.log("   登录成功后会自动保存 Cookie\n");

  const browser = await chromium.launch({
    headless: false, // 必须有界面让用户登录
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // 去掉 webdriver 标记
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded" });

  console.log("⏳ 等待登录完成...");
  console.log("   请扫码或输入手机号登录");
  console.log("   登录成功后脚本会自动检测并保存 Cookie\n");

  // 轮询检测登录状态 - 最多等 3 分钟
  let loggedIn = false;
  const MIN_WAIT = 10; // 至少等 10 秒再开始检测，给用户时间操作

  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000);

    if (i < MIN_WAIT) {
      if (i === MIN_WAIT - 1) console.log("   开始检测登录状态...");
      continue;
    }

    // 只通过 cookie 判断是否登录成功
    // 小红书登录后会设置这些关键 cookie
    const cookies = await context.cookies();
    const hasWebSession = cookies.some((c) => c.name === "web_session");
    const hasAccessToken = cookies.some((c) => c.name === "access-token-v2");
    const hasCustomerSn = cookies.some((c) => c.name === "customer-sn");

    // 需要至少两个关键 cookie 同时存在才认为登录成功
    const loginIndicators = [hasWebSession, hasAccessToken, hasCustomerSn].filter(Boolean).length;

    if (loginIndicators >= 2) {
      loggedIn = true;
      break;
    }

    // 备用检测：检查 URL 是否从登录页跳走了
    const currentUrl = page.url();
    if (i > 20 && !currentUrl.includes("login") && cookies.length > 10) {
      // 很多 cookie + 不在登录页 = 可能已登录
      loggedIn = true;
      break;
    }

    if (i % 15 === 0 && i > MIN_WAIT) {
      console.log(`   还在等待... (${i}s) - 检测到 ${cookies.length} 条cookie`);
    }
  }

  if (loggedIn) {
    // 保存所有 cookies
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
    console.log(`\n✅ 登录成功！Cookie 已保存到: ${COOKIE_PATH}`);
    console.log(`   共 ${cookies.length} 条 cookie`);

    // 验证：尝试访问搜索页
    console.log("\n🔍 验证中：尝试访问搜索页...");
    await page.goto(
      "https://www.xiaohongshu.com/search_result?keyword=巴黎美食&source=web_search_result_note",
      { waitUntil: "domcontentloaded", timeout: 15000 }
    );
    await page.waitForTimeout(3000);

    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 200));
    if (pageText.includes("登录后查看")) {
      console.log("⚠️  搜索页仍然要求登录，Cookie 可能未生效");
    } else {
      console.log("✅ 搜索页可正常访问！");
    }
  } else {
    console.log("\n❌ 登录超时（3分钟内未检测到登录状态）");
    console.log("   请重新运行此脚本");
  }

  await browser.close();
}

login().catch(console.error);
