// backend/server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Use PORT from environment (Render will set) or default 3001
const PORT = process.env.PORT || 3001;

// Simple in-memory store for demo (reset on server restart)
const USERS = {
  // example user
  "FM10293": {
    userId: "FM10293",
    name: "Minh Anh",
    balanceUSD: 2000, // mock fiat balance for simulation
    portfolio: {
      bitcoin: 0.1,
      ethereum: 1,
      solana: 20
    }
  }
};

// Helper: fetch coin market data from CoinGecko
async function fetchCoinGecko(ids = ["bitcoin","ethereum","solana"]) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
  const data = await res.json();
  // normalize by id -> { id: {...} }
  const map = {};
  data.forEach((c) => { map[c.id] = c; });
  return map;
}

// Endpoint: get market data for coins (frontend calls this)
app.get("/api/coins", async (req, res) => {
  try {
    const ids = (req.query.ids || "bitcoin,ethereum,solana").split(",");
    const data = await fetchCoinGecko(ids);
    res.json({ success: true, data });
  } catch (err) {
    console.error("GET /api/coins err:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: get profile & computed portfolio value (userId param optional)
app.get("/api/profile/:userId?", async (req, res) => {
  try {
    const userId = req.params.userId || "FM10293";
    const user = USERS[userId];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const coins = await fetchCoinGecko(Object.keys(user.portfolio));
    // compute portfolio value
    let total = 0;
    const breakdown = {};
    for (const [coinId, qty] of Object.entries(user.portfolio)) {
      const price = coins[coinId]?.current_price || 0;
      const value = qty * price;
      breakdown[coinId] = { qty, price, value, change24h: coins[coinId]?.price_change_percentage_24h || 0 };
      total += value;
    }

    res.json({
      success: true,
      profile: { userId: user.userId, name: user.name, balanceUSD: user.balanceUSD },
      portfolio: { totalValue: total, breakdown }
    });
  } catch (err) {
    console.error("GET /api/profile err:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: simulate transaction (buy/sell)
// body: { userId, action: "buy"|"sell", coinId, amountUsd OR qty }
app.post("/api/transaction", async (req, res) => {
  try {
    const { userId = "FM10293", action, coinId, amountUsd, qty } = req.body;
    const user = USERS[userId];
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const coins = await fetchCoinGecko([coinId]);
    const price = coins[coinId]?.current_price;
    if (!price) return res.status(400).json({ success: false, error: "Invalid coinId or price not available" });

    // Determine qty if given amountUsd
    const tradeQty = qty ?? (amountUsd ? (amountUsd / price) : 0);
    if (tradeQty <= 0) return res.status(400).json({ success: false, error: "Invalid trade quantity/amount" });

    if (action === "buy") {
      const cost = tradeQty * price;
      if (cost > user.balanceUSD) {
        return res.json({ success: false, status: "error", message: "Không đủ tiền trong ví mô phỏng." });
      }
      // apply trade
      user.balanceUSD -= cost;
      user.portfolio[coinId] = (user.portfolio[coinId] || 0) + tradeQty;
      return res.json({ success: true, status: "ok", message: "Giao dịch mua thành công", newBalance: user.balanceUSD });
    } else if (action === "sell") {
      const have = user.portfolio[coinId] || 0;
      if (tradeQty > have) {
        return res.json({ success: false, status: "error", message: "Không đủ số lượng để bán." });
      }
      const proceed = tradeQty * price;
      user.portfolio[coinId] = have - tradeQty;
      user.balanceUSD += proceed;
      return res.json({ success: true, status: "ok", message: "Giao dịch bán thành công", newBalance: user.balanceUSD });
    } else {
      return res.status(400).json({ success: false, error: "action must be buy or sell" });
    }
  } catch (err) {
    console.error("POST /api/transaction err:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Optional: simple chat endpoint that proxies to Gemini if API key present
app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "";
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      // return a helpful mock response that can still reference portfolio
      // Example: if user asks "balance" we'll return stored user balance
      if (/balance|tổng/i.test(message)) {
        const u = USERS["FM10293"];
        return res.json({ success: true, reply: `Số dư mô phỏng của bạn là $${u.balanceUSD.toFixed(2)}.` });
      }
      return res.json({ success: true, reply: "Chat API chưa cấu hình GEMINI_API_KEY. Bạn có thể hỏi: 'Số dư của tôi là bao nhiêu?'" });
    }

    // If key exists, call Google Generative Language API (generateContent)
    const model = "models/gemini-2.5-flash"; // change if needed
    const endpoint = `https://generativelanguage.googleapis.com/v1/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [{ parts: [{ text: message }] }]
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Xin lỗi, tôi không có phản hồi từ model.";
    return res.json({ success: true, reply });
  } catch (err) {
    console.error("POST /api/chat error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
