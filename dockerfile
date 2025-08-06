# 使用 Node.js Alpine 镜像作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用程序代码
COPY . .

# 创建非root用户来运行应用
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodeuser -u 1001

# 创建必要目录并设置权限
RUN mkdir -p /app/img /app/public /app/uploads && \
    chown -R nodeuser:nodejs /app

# 切换到非root用户
USER nodeuser

# 暴露 HTTP 和 HTTPS 端口
EXPOSE 3000 3001

# 创建匿名卷
VOLUME ["/app/img", "/app/public", "/app/ssl"]

# 启动应用
CMD ["npm", "start"]