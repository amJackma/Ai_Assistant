# Deployment Guide

## Overview

This project is a Windows-only Electron desktop application with a backend server component. The desktop application runs on Windows, while the backend server can be deployed to cloud platforms like Render.

## Deployment Checklist

- [x] Environment variables configured
- [x] Build scripts set up
- [x] Backend server created
- [x] Deployment files ready
- [ ] OpenAI API key configured on Render
- [ ] Application deployed and tested

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Add your OpenAI API key to `.env`

4. Run development server:
```bash
npm run dev
```

5. Build for production:
```bash
npm run build
```

## Deployment on Render

### Prerequisites

- A Render account (https://render.com)
- Your OpenAI API key
- GitHub repository connected to Render

### Steps

1. **Push to GitHub** (already done)

2. **Create a new Web Service on Render:**
   - Go to https://dashboard.render.com
   - Click "New +" → "Web Service"
   - Connect your GitHub repository `amJackma/Ai_Assistant`

3. **Configure the service:**
   - **Name:** interview-assistant
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist-electron/server.js`
   - **Instance Type:** Free or Starter plan

4. **Add Environment Variables:**
   - `NODE_ENV` = `production`
   - `OPENAI_API_KEY` = Your OpenAI API key
   - `OPENAI_FAST_ANSWER_MODEL` = `gpt-5.6-luna` (or your model)
   - `OPENAI_CODING_MODEL` = `gpt-5.6-sol` (or your model)
   - `OPENAI_FAST_REASONING_EFFORT` = `low`
   - `OPENAI_CODING_REASONING_EFFORT` = `high`

5. **Deploy:**
   - Click "Create Web Service"
   - Wait for the build and deployment to complete
   - Your application will be available at: `https://interview-assistant.onrender.com`

6. **Verify Deployment:**
   - Health check: `https://your-service-url/api/health`
   - Status: `https://your-service-url/api/status`

## Important Notes

### Desktop App vs. Cloud Backend

- The **desktop Electron application** must run on **Windows 10/11** locally
- The **backend server** deployed to Render provides API endpoints and serves the web interface
- The desktop app and web server can communicate via REST APIs

### Environment Variables

Never commit the `.env` file with real secrets. Render provides:
- Environment variable management through the dashboard
- Automatic encryption of sensitive values
- Version control without exposing secrets

### Monitoring and Logs

After deployment, monitor your service:
- View logs: Render Dashboard → Your Service → Logs
- Check status: `/api/health` endpoint
- Monitor resource usage: Render Dashboard → Usage

### Scaling

- **Free Tier:** Limited resources, spins down after 15 minutes of inactivity
- **Paid Plans:** Recommended for production with consistent uptime
- Consider upgrading if you need better performance

## Troubleshooting

### Build Fails
- Check `package.json` scripts are correct
- Verify Node.js version >= 20
- Check all dependencies are in `package.json`

### API Key Not Working
- Verify `OPENAI_API_KEY` is set in Render dashboard
- Check key has access to required models
- Review Render logs for errors

### Service Won't Start
- Check build command output in logs
- Verify `start` command is correct
- Ensure all ports are available

### CORS Issues
- Backend includes CORS headers for all origins
- Check browser console for specific CORS errors

## Rolling Back

To rollback to a previous version on Render:
1. Go to Service Settings
2. Click "Redeploy" on a previous build
3. Or push a new commit with the fix

## Security Best Practices

1. **Never commit `.env` files**
2. **Use Render's environment variable management** for secrets
3. **Keep dependencies updated:** `npm update`
4. **Review security advisories:** `npm audit`
5. **Use HTTPS only** (automatic on Render)
6. **Restrict API access** by implementing authentication if needed
7. **Monitor API usage** on OpenAI dashboard

## Support

- Render Docs: https://render.com/docs
- OpenAI Docs: https://platform.openai.com/docs
- GitHub Issues: Check the project repository
