const OpenAI = require("openai");
const config = require("../config");

/**
 * DeepSeek AI 服务
 * 负责：1) 餐厅名翻译/关键词生成  2) 评价摘要与情感分析
 */
const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseUrl,
});

/**
 * 将餐厅名称翻译为中文搜索关键词
 * 严格按照餐厅原名搜索，避免召回无关餐厅
 */
async function generateSearchKeywords(name, city, cuisine = "") {
  const prompt = `你是小红书搜索优化助手。我需要在小红书上精确搜索一家海外餐厅的评价。

餐厅原名：${name}
城市：${city}

请生成 2-3 个搜索关键词，严格遵守以下规则：
1. 必须包含餐厅的【完整原名】，不要缩写、不要只取部分单词
2. 不要用模糊的菜系词替代餐厅名（如不要把 "Le Florimond" 搜成 "巴黎法餐推荐"）
3. 可以组合的后缀只有：城市中文名、"餐厅"、"探店"
4. 如果餐厅名有公认的中文译名，可以额外加一条中文名搜索

好的关键词示例：
- "Le Florimond" → ["Le Florimond", "Le Florimond 巴黎"]
- "Kodawari Ramen" → ["Kodawari Ramen", "Kodawari Ramen 巴黎", "誉田拉面 巴黎"]
- "鸟貴族" → ["鸟贵族 东京", "鸟貴族"]

坏的关键词示例（禁止）：
- "巴黎法餐推荐"（太泛，会召回无关餐厅）
- "Florimond"（不完整，会匹配到 Le Florentin 等）
- "巴黎好吃的拉面"（完全丢失了餐厅名）

返回JSON数组，不要其他内容：
["关键词1", "关键词2"]`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: 150,
  });

  const text = response.choices[0].message.content.trim();

  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.error("[AI] 关键词解析失败:", text);
  }

  // 降级：严格使用原名
  return [name, `${name} ${city}`];
}

/**
 * 分析小红书笔记，生成结构化评价摘要
 * 包含相关性过滤、中国胃指数、推荐菜、预订信息
 */
async function analyzeReviews(restaurantName, city, notes) {
  if (!notes || notes.length === 0) {
    return {
      rating: "unknown",
      summary: "暂无小红书相关评价数据",
      pros: [],
      cons: [],
      practicalInfo: {},
      noteCount: 0,
      adCount: 0,
    };
  }

  const notesText = notes
    .map((n, i) => `[${i + 1}] 标题：${n.title}\n内容：${n.desc}\n点赞：${n.likes}\n作者：${n.author}`)
    .join("\n\n");

  const prompt = `你是帮助中国游客做海外餐厅决策的AI。请分析以下小红书笔记。

## 目标餐厅：「${restaurantName}」（${city}）

## 搜索到的笔记：
${notesText}

## 重要：相关性过滤
首先判断每条笔记是否真的在讨论「${restaurantName}」这家餐厅。
- 如果笔记讨论的是另一家餐厅（名字相似但不同），标记为"无关"
- 只基于确认相关的笔记进行分析
- 如果所有笔记都无关，rating 设为 "no_data"

## 请按以下JSON格式输出（不要输出其他内容）：
{
  "relevantNoteCount": 3,
  "irrelevantNotes": [{"index": 2, "reason": "该笔记讨论的是Le Florentin而非Le Florimond"}],
  "rating": "strongly_recommend|recommend|caution|avoid|no_data",
  "ratingLabel": "强烈推荐|推荐|谨慎|避雷|无有效数据",
  "summary": "一句话总结（15-25字）",
  "chineseStomachIndex": {
    "score": 4,
    "reason": "笔记提到'口味偏清淡适合中国人'、'有热汤'"
  },
  "recommendedDishes": [
    {"name": "菜名（原文+中文）", "reason": "推荐理由"}
  ],
  "needReservation": "需要提前预约/不需要/未提及",
  "pros": ["好评要点1", "好评要点2"],
  "cons": ["差评要点1", "差评要点2"],
  "practicalInfo": {
    "avgPrice": "人均价格（如有）",
    "waitTime": "排队等位时间（如有）",
    "paymentMethod": "支付方式（如有）",
    "chineseMenu": "是否有中文菜单/图片菜单（如有）",
    "tips": "实用小贴士（如有）"
  },
  "adCount": 0,
  "confidence": "high|medium|low"
}

## 分析规则：
1. chineseStomachIndex.score 范围 1-5：
   - 5分：笔记明确说"好吃""适合中国胃""味道正"
   - 4分：整体正面，无负面口味评价
   - 3分：口味中性，或"还行""一般"
   - 2分：出现"不太习惯""偏甜/偏咸""中国人可能不适应"
   - 1分：明确说"不好吃""难以接受""踩雷"
   - reason 字段只写口味相关的实质性描述（如"口味偏清淡""有热汤""味道正宗"）
   - 禁止出现"笔记1觉得""多位用户认为""笔记评价"等指代具体笔记的说法
2. recommendedDishes：从笔记中提取被推荐的具体菜品名称。
   - reason 字段只填实质性推荐理由（如"好吃绝了""性价比高""入口焦香"等口味/体验描述）
   - 禁止使用"笔记[1]提及""笔记[2]明确推荐""多位笔记推荐"这类无意义的引用说明
   - 如果某菜品只是被提到但没有实质推荐理由，reason 填空字符串 ""
3. needReservation：关注"预约""订位""walk-in""排队"等关键词
4. 广告识别：过度吹捧+含优惠码的标记为广告
5. 如果相关笔记数为0，所有分析字段返回空/null，rating设为"no_data"`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const text = response.choices[0].message.content.trim();

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      result.noteCount = notes.length;
      return result;
    }
  } catch (e) {
    console.error("[AI] 评价分析解析失败:", text);
  }

  return {
    rating: "unknown",
    summary: "AI分析失败，请查看原始笔记",
    pros: [],
    cons: [],
    practicalInfo: {},
    noteCount: notes.length,
    adCount: 0,
    confidence: "low",
  };
}

/**
 * 本地降级分析 — 当 DeepSeek API 不可用时，用简单规则分析笔记
 */
function localAnalyze(restaurantName, notes) {
  const texts = notes.map((n) => `${n.title} ${n.desc}`).join(" ");

  // 简单关键词匹配
  const posWords = ["推荐", "好吃", "正宗", "值得", "惊艳", "必点", "不错", "满意", "回购", "五星"];
  const negWords = ["避雷", "踩雷", "失望", "难吃", "不值", "差评", "一般", "太贵", "不推荐", "后悔"];

  let posCount = 0, negCount = 0;
  posWords.forEach((w) => { posCount += (texts.match(new RegExp(w, "g")) || []).length; });
  negWords.forEach((w) => { negCount += (texts.match(new RegExp(w, "g")) || []).length; });

  const total = posCount + negCount || 1;
  const posRatio = posCount / total;

  let rating, ratingLabel;
  if (posRatio > 0.8) { rating = "strongly_recommend"; ratingLabel = "强烈推荐"; }
  else if (posRatio > 0.6) { rating = "recommend"; ratingLabel = "推荐"; }
  else if (posRatio > 0.4) { rating = "caution"; ratingLabel = "谨慎"; }
  else { rating = "avoid"; ratingLabel = "避雷"; }

  // 提取关键信息
  const pros = [], cons = [];
  notes.forEach((n) => {
    const t = `${n.title} ${n.desc}`;
    posWords.forEach((w) => { if (t.includes(w) && pros.length < 4) pros.push(t.slice(t.indexOf(w) - 5, t.indexOf(w) + 15).trim()); });
    negWords.forEach((w) => { if (t.includes(w) && cons.length < 3) cons.push(t.slice(t.indexOf(w) - 5, t.indexOf(w) + 15).trim()); });
  });

  // 提取价格信息
  const priceMatch = texts.match(/人均[约]?(\d+)/);
  const waitMatch = texts.match(/(排队|等)[约了]?(\d+)/);

  return {
    rating,
    ratingLabel,
    summary: `基于${notes.length}条笔记本地分析（AI服务暂不可用）`,
    pros: [],
    cons: [],
    practicalInfo: {
      avgPrice: priceMatch ? `约${priceMatch[1]}元` : null,
      waitTime: waitMatch ? `约${waitMatch[2]}分钟` : null,
      paymentMethod: texts.includes("支付宝") ? "支持支付宝" : texts.includes("现金") ? "建议带现金" : null,
      chineseMenu: texts.includes("中文菜单") ? "有" : null,
      tips: null,
    },
    noteCount: notes.length,
    adCount: 0,
    confidence: notes.length >= 5 ? "medium" : "low",
    analysisMode: "local",
  };
}

/**
 * 带降级的评价分析 — 先尝试 DeepSeek，失败则本地分析
 */
async function analyzeReviewsWithFallback(restaurantName, city, notes) {
  try {
    return await analyzeReviews(restaurantName, city, notes);
  } catch (err) {
    console.warn("[AI] DeepSeek 调用失败，降级到本地分析:", err.message);
    return localAnalyze(restaurantName, notes);
  }
}

/**
 * 带降级的关键词生成 — 降级时也严格使用原名
 */
async function generateKeywordsWithFallback(name, city, cuisine) {
  try {
    return await generateSearchKeywords(name, city, cuisine);
  } catch (err) {
    console.warn("[AI] 关键词生成失败，使用默认:", err.message);
    // 严格使用原名，不做任何创造性改写
    return [name, `${name} ${city}`];
  }
}

module.exports = { generateSearchKeywords, analyzeReviews, analyzeReviewsWithFallback, generateKeywordsWithFallback };

