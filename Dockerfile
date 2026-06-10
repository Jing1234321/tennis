FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4173

CMD ["npm", "start"]
