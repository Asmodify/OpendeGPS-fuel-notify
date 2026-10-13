# GPS fuel monitor (Fuel Tank Warner) for the Vultr server. Data lives in /data (a volume).
FROM node:24-slim
ENV NODE_ENV=production TZ=Asia/Ulaanbaatar HOST=0.0.0.0 PORT=8080 \
    DATA_DIR=/data EXCEL_FILE="/data/Fuel events.xlsx"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY config.json calibrations.example.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "src/server.js"]
