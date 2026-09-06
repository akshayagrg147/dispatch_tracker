FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.html schema.sql server.mjs ./
COPY server ./server
COPY scripts ./scripts

USER node
EXPOSE 8000
CMD ["npm", "start"]
