# Cloud Run Job do sync GestãoClick → Firestore (mesmo scripts/sync-dados.js que roda no GitHub Actions).
FROM node:20-slim
WORKDIR /app
COPY scripts/package.json scripts/package.json
RUN npm install --prefix scripts --omit=dev --no-audit --no-fund
COPY scripts scripts
COPY functions/lib functions/lib
ENV NODE_ENV=production
USER node
CMD ["node", "scripts/sync-dados.js"]
