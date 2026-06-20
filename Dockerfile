# Puppeteer needs a real Chromium + its system libraries. This image bundles
# them so Railway/Render/Fly can run headless Chrome reliably.
FROM ghcr.io/puppeteer/puppeteer:23.0.0

# The base image runs as user "pptruser" and already has Chromium installed.
ENV PUPPETEER_SKIP_DOWNLOAD=false
ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Railway/Render inject PORT; default to 8080 locally.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
