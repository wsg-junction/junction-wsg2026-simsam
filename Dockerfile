FROM node:26-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/models/package.json packages/models/
RUN npm ci

COPY . .
RUN npm run build -w web

# What is running: shown on the Health page.
ARG BUILD_SHA=
ARG BUILD_TIME=
ENV NODE_ENV=production PORT=3000 BUILD_SHA=$BUILD_SHA BUILD_TIME=$BUILD_TIME
EXPOSE 3000
CMD ["npm", "start", "-w", "api"]
