#!/bin/bash
# CADtomie Deployment Script
# Run this in your Terminal from the CADtomie folder

set -e
REPO="cadtomie"
GITHUB_USER="mnauroz"

echo "=== CADtomie Deployment Setup ==="

# Step 1: Initialize git (remove existing .git if needed)
cd "$(dirname "$0")"
echo "📁 Working directory: $(pwd)"

# Remove any broken .git from sandbox
if [ -f ".git/index.lock" ]; then
  rm -f .git/index.lock
fi

# Init or reinit
if [ ! -d ".git" ]; then
  git init
fi

git branch -M main

# Step 2: Stage everything except secrets
git add -A
git status --short

# Step 3: Commit
git commit -m "Initial commit: CADtomie orthopedic analysis app

Beta release — auth and billing disabled for testing."

echo ""
echo "✅ Git ready. Now creating GitHub repo..."
echo ""

# Step 4: Check if gh CLI is available
if command -v gh &>/dev/null; then
  echo "Using GitHub CLI..."
  gh repo create "$GITHUB_USER/$REPO" --public --source=. --push
  echo "✅ Pushed to GitHub!"
else
  echo "⚠️  GitHub CLI not found. Run these commands manually:"
  echo ""
  echo "  1. Go to https://github.com/new"
  echo "  2. Name: $REPO  — choose Public"
  echo "  3. Do NOT add README/gitignore (we have our own)"
  echo "  4. Then run:"
  echo ""
  echo "     git remote add origin https://github.com/$GITHUB_USER/$REPO.git"
  echo "     git push -u origin main"
  echo ""
fi

echo ""
echo "=== Next: Deploy to Render & Vercel ==="
echo ""
echo "BACKEND (Render):"
echo "  1. Go to https://render.com and sign in"
echo "  2. New → Web Service → Connect GitHub → select $REPO"
echo "  3. Root Directory: backend"
echo "  4. Runtime: Python 3"
echo "  5. Build Command: pip install -r requirements.txt"
echo "  6. Start Command: python -m uvicorn main:app --host 0.0.0.0 --port \$PORT"
echo "  7. Plan: Starter (\$7/mo)"
echo "  8. Add environment variables (see backend/.env.example)"
echo ""
echo "FRONTEND (Vercel):"
echo "  1. Go to https://vercel.com and sign in"
echo "  2. New Project → Import from GitHub → select $REPO"
echo "  3. Root Directory: frontend"
echo "  4. Framework: Vite"
echo "  5. Add environment variable:"
echo "     VITE_API_BASE_URL = https://<your-render-service>.onrender.com"
echo "     VITE_SUPABASE_URL = (your supabase url)"
echo "     VITE_SUPABASE_ANON_KEY = (your anon key)"
echo ""
