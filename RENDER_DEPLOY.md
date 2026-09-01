# 🚀 Quick Start: Deploy on Render

## Step-by-Step Deployment Guide

### Prerequisites
- Render.com account (sign up at https://render.com)
- OpenAI API key with access to your configured models
- GitHub repository (already connected to: https://github.com/amJackma/Ai_Assistant)

---

## 1. Deploy on Render (5 minutes)

### A. Connect Repository
1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect Repository"**
4. Search for and select **`Ai_Assistant`**
5. Click **"Connect"**

### B. Configure Service
Set these values in the Render form:

| Field | Value |
|-------|-------|
| **Name** | `interview-assistant` |
| **Environment** | `Node` |
| **Region** | Select closest region |
| **Branch** | `master` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `node dist-electron/server.js` |
| **Instance Type** | `Free` or `Starter Plus` |

### C. Add Environment Variables
Click **"Advanced"** then **"Add Environment Variable"** for each:

```
NODE_ENV = production
PORT = 3000
OPENAI_API_KEY = [your-actual-api-key-here]
OPENAI_FAST_ANSWER_MODEL = gpt-5.6-luna
OPENAI_CODING_MODEL = gpt-5.6-sol
OPENAI_FAST_REASONING_EFFORT = low
OPENAI_CODING_REASONING_EFFORT = high
LOG_LEVEL = info
```

⚠️ **IMPORTANT:** Click the toggle next to `OPENAI_API_KEY` to mark it as a **secret** (it won't be exposed in logs)

### D. Deploy
Click **"Create Web Service"** and wait for deployment (2-5 minutes)

---

## 2. Verify Deployment ✅

Once deployed, your service URL will appear (e.g., `https://interview-assistant.onrender.com`):

### Check Health
Open in browser or curl:
```bash
curl https://interview-assistant.onrender.com/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-09-01T...",
  "environment": "production",
  "version": "0.1.0"
}
```

### Check API Status
```bash
curl https://interview-assistant.onrender.com/api/status
```

Expected response:
```json
{
  "status": "running",
  "apiKeyConfigured": true,
  "models": {
    "fastAnswer": "gpt-5.6-luna",
    "coding": "gpt-5.6-sol"
  }
}
```

---

## 3. Local Desktop App Configuration

Once deployed, update your local Electron app to use the cloud backend:

1. **For Production:**
   - Open `src/App.tsx`
   - Update API endpoint to: `https://interview-assistant.onrender.com`

2. **Run Locally:**
   ```bash
   npm run dev
   ```

---

## 4. Monitor & Manage

### View Logs
- **Render Dashboard** → Your Service → **"Logs"**
- Shows build output, errors, API calls in real-time

### Manual Deploy
- **Redeploy:** Service Settings → **"Redeploy"**
- Triggered on git push to `master` branch

### View Environment Variables
- Service Settings → **"Environment"**
- Update values without rebuilding

### Stop Service
- Service Settings → **"Suspend"**
- Useful to save resources on Free tier

---

## 5. Troubleshooting

| Issue | Solution |
|-------|----------|
| **Build fails** | Check Render logs, verify `npm run build` works locally |
| **"Cannot find module"** | Run `npm install` locally, check `package.json` |
| **API Key rejected** | Verify key in Render dashboard (exact copy, no spaces) |
| **Port already in use** | Render manages ports automatically, no action needed |
| **CORS errors** | Backend has open CORS; check browser console for details |
| **Service spins down** | Free tier sleeps after 15 min inactivity; upgrade for persistence |

---

## 6. What's Deployed?

### Backend Server (Runs on Render)
- Express.js server on port 3000
- REST API endpoints (`/api/health`, `/api/status`)
- Serves the React frontend
- Handles environment variables securely

### Desktop App (Runs Locally on Windows)
- Electron desktop application
- Windows 10/11 only
- Can communicate with cloud backend
- Captures audio/screen locally

---

## 7. Costs

### Render Pricing
| Plan | Price | Auto-sleep | Uptime |
|------|-------|-----------|--------|
| **Free** | $0/month | Yes (15 min) | ~99% |
| **Starter Plus** | $12/month | No | 99.99% |
| **Standard** | $25/month | No | 99.99% |

### OpenAI API Costs
- Varies by model and usage
- Monitor at https://platform.openai.com/account/billing/overview
- Set usage limits to avoid surprise charges

---

## 8. Next Steps

✅ **Deployed!** Your app is now running on Render.

- **Monitor:** Watch the logs for issues
- **Iterate:** Make changes locally, push to GitHub, auto-redeploy
- **Scale:** Upgrade plan if needed for production use
- **Custom Domain:** Add a custom domain in Render settings
- **SSL/HTTPS:** Automatic (included with Render)

---

## 📞 Support

| Issue | Help |
|-------|------|
| Render problems | [Render Docs](https://render.com/docs) |
| OpenAI issues | [OpenAI Help](https://help.openai.com) |
| Deployment questions | See [DEPLOYMENT.md](DEPLOYMENT.md) in project root |

---

**Last Updated:** 2026-09-01  
**Status:** ✅ Deployment Ready
