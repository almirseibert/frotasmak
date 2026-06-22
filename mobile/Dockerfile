# --- Build da versão web do app Expo ---
FROM node:20-alpine AS build
WORKDIR /app

# CI=true evita o erro "GetEnv.NoBoolean" do Expo CLI e força modo não-interativo
ENV CI=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx expo export -p web --output-dir dist

# --- Servidor estático ---
FROM node:20-alpine AS runner
WORKDIR /app

RUN npm install -g serve@14

COPY --from=build /app/dist ./dist

ENV PORT=3000
EXPOSE 3000

# -s = single-page app (faz fallback para index.html nas rotas)
CMD ["sh", "-c", "serve -s dist -l tcp://0.0.0.0:${PORT}"]
