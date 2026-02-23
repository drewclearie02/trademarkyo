# Trademarkyo — Deploy Guide

## What this is
A web app that queries the live USPTO trademark database and uses AI to score your trademark approval likelihood.

## How to deploy (no coding required)

### Step 1 — Put this on GitHub
1. Go to github.com and create a free account
2. Click the "+" icon → "New repository"
3. Name it: `trademarkyo`
4. Set it to Public, click "Create repository"
5. Click "uploading an existing file"
6. Drag ALL files from this folder into the upload box
7. Click "Commit changes"

### Step 2 — Deploy on Railway
1. Go to railway.app and sign up with your GitHub account
2. Click "New Project"
3. Click "Deploy from GitHub repo"
4. Select your `trademarkyo` repo
5. Railway will detect it's a Node.js app automatically
6. Click "Deploy"

### Step 3 — Add your Anthropic API key
1. In Railway, click your project
2. Click "Variables"
3. Click "New Variable"
4. Name: `ANTHROPIC_API_KEY`
5. Value: your Anthropic API key (get it at console.anthropic.com)
6. Hit Save — Railway auto-redeploys

### Step 4 — Connect trademarkyo.com
1. In Railway, go to "Settings" → "Networking" → "Custom Domain"
2. Type: `trademarkyo.com`
3. Railway gives you a DNS record to add in GoDaddy
4. In GoDaddy DNS, add that record
5. Done — live in ~10 minutes

## Cost
- Railway: Free tier to start, ~$5-7/month when you scale
- Anthropic API: ~$0.01 per search (essentially free at low volume)
