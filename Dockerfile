# Salve este arquivo dentro da sua pasta 'backend'

# Etapa 1: Usar uma imagem base do Node.js
FROM node:18-alpine

# Etapa 2: Definir o diretório de trabalho dentro do contêiner
WORKDIR /usr/src/app

# Etapa 3: Copiar o package.json e o package-lock.json
COPY package*.json ./

# Etapa 4: Instalar as dependências do projeto
RUN npm install

# Etapa 5: Copiar o restante do código da sua aplicação
COPY . .

# Etapa 6: Expor a porta que sua aplicação usa
EXPOSE 3001

# Etapa 7: Comando para iniciar sua aplicação
CMD [ "node", "server.js" ]
