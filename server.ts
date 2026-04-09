import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set in environment.");
}

async function callEdgeFunction(functionName: string, body: any) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // Proxy: Fetch emails
  app.get("/api/emails", async (_req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: "Server not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY." });
    }
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      });
      const data = await response.text();
      res.status(response.status).set("Content-Type", "application/json").send(data);
    } catch (err) {
      console.error("Email fetch error:", err);
      res.status(502).json({ success: false, error: "Cannot reach backend. Check server configuration." });
    }
  });

  // Proxy: Login notification
  app.post("/api/auth/notify", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: "Server not configured." });
    }
    try {
      const data = await callEdgeFunction("send-login-notification", req.body);
      res.json(data);
    } catch (err) {
      res.status(502).json({ success: false, error: "Cannot reach backend notification service." });
    }
  });

  // Proxy: Manage app (users, settings, otps)
  app.post("/api/manage-app", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: "Server not configured." });
    }
    try {
      const upstream = await fetch(`${SUPABASE_URL}/functions/v1/manage-app`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify(req.body),
      });
      const data = await upstream.text();
      res.status(upstream.status).set("Content-Type", "application/json").send(data);
    } catch (err) {
      res.status(502).json({ success: false, error: "Cannot reach backend." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

const appPromise = startServer();
export default async function (req: any, res: any) {
  const app = await appPromise;
  return app(req, res);
}
