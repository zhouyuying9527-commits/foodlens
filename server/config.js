require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3000,
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  },
  serpapi: {
    key: process.env.SERPAPI_KEY || "",
  },
};
