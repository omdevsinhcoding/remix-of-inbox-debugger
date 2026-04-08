import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://osxinhctzabxeycyeflg.supabase.co";
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zeGluaGN0emFieGV5Y3llZmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NjY1MTUsImV4cCI6MjA5MTE0MjUxNX0.0_8_c1rxRXVOFUzC2aLjoRubLViSVo1qgeNvkbBMvFQ";

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
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      });
      const data = await response.json();
      res.json(data);
    } catch (err) {
      console.error("Email fetch error:", err);
      res.status(500).json({ success: false, error: "Failed to fetch emails" });
    }
  });

  // Proxy: Login notification
  app.post("/api/auth/notify", async (req, res) => {
    try {
      const data = await callEdgeFunction("send-login-notification", req.body);
      res.json(data);
    } catch (err) {
      res.status(500).json({ success: false, error: "Failed to send notification" });
    }
  });

  // Proxy: Manage app (users, settings, otps)
  app.post("/api/manage-app", async (req, res) => {
    try {
      const data = await callEdgeFunction("manage-app", req.body);
      res.json(data);
    } catch (err) {
      res.status(500).json({ success: false, error: "Request failed" });
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
