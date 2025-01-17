#Build stage

FROM node:22 AS build

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

#Production stage

FROM node:22 AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY --from=build /app/dist ./dist

COPY --from=build /app/data ./data

CMD ["node", "dist/index.js"]