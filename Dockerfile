FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=prod

COPY dist/ dist/

ENTRYPOINT ["node", "dist/index.js"]
