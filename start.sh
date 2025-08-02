#!/bin/bash

set -e

REQUIRED_NODE_VERSION=14

echo "📋 检测 Node.js 版本..."

if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v | sed 's/v//;s/\..*//') # 只取主版本号
  echo "当前 Node.js 版本: v$NODE_VERSION"
  if (( NODE_VERSION < REQUIRED_NODE_VERSION )); then
    echo "❌ Node.js 版本太低，需要 v$REQUIRED_NODE_VERSION 及以上"
    exit 1
  fi
else
  echo "❌ 未检测到 Node.js，尝试安装中..."

  # 判断系统并安装 Node.js
  if [ -f /etc/debian_version ]; then
    echo "检测到 Debian/Ubuntu 系统"
    sudo apt update
    sudo apt install -y nodejs npm || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  elif [ -f /etc/redhat-release ]; then
    echo "检测到 CentOS/RHEL 系统"
    sudo yum install -y epel-release
    sudo yum install -y nodejs npm || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  elif [ -f /etc/fedora-release ]; then
    echo "检测到 Fedora 系统"
    sudo dnf install -y nodejs npm || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  elif [ -f /etc/arch-release ]; then
    echo "检测到 Arch Linux 系统"
    sudo pacman -Sy --noconfirm nodejs npm || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  elif [ -f /etc/alpine-release ]; then
    echo "检测到 Alpine Linux 系统"
    sudo apk add nodejs npm || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "检测到 macOS"
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew 未安装，请先安装 Homebrew: https://brew.sh/"
      exit 1
    fi
    brew install node || {
      echo "安装失败，请手动安装 Node.js"
      exit 1
    }
  else
    echo "未知系统，请手动安装 Node.js"
    exit 1
  fi

  echo "✅ Node.js 安装完成"
fi

echo "📦 检查依赖安装..."
if [ ! -d node_modules ]; then
  echo "安装依赖中..."
  npm install
fi

mkdir -p logs

echo "🚀 后台启动服务..."
nohup node app.js > logs/out.log 2>&1 &

echo "✅ 服务已在后台启动，日志输出到 logs/out.log"
