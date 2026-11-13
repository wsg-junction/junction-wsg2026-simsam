FROM node:26-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/models/package.json packages/models/
RUN npm ci

COPY . .
RUN npm run build -w web

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start", "-w", "api"]
