FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    UI_PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY web ./web
COPY ALF-*.xlsx ./
# Uploads land in INBOX_DIR (the project root) and reports in output/, so the app user must own /app.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "build/server.js"]
