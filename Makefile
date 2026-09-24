# mini-sglang 源码可视化的常用命令。
#
# 依赖：cargo（Rust 1.80+）、npm（Node 20+）。
# 被分析的仓库默认在 ../mini-sglang，可用 MINISGL_SRC 覆盖。

MINISGL_SRC ?= ../mini-sglang
DATA ?= data
DIST ?= frontend/dist
PORT ?= 8787

.PHONY: help all extract build serve dev test check check-scenario check-views check-all fmt clean

default: help

help: ## 列出所有可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-16s %s\n", $$1, $$2}'

all: extract build ## 抽取并构建前端

extract: ## 解析源码，写出 data/*.json
	cd backend && cargo run --release -- extract --src $(MINISGL_SRC) --out ../$(DATA)

build: ## 构建前端产物
	cd frontend && npm install && npm run build

serve: ## 起服务（API + 前端产物）
	cd backend && cargo run --release -- serve --data ../$(DATA) --dist ../$(DIST) --port $(PORT)

dev: ## 前端开发模式，/api 自动代理到 $(PORT)
	cd frontend && npm run dev

test: ## 后端测试：golden 对等、内容引用
	cd backend && cargo test

check-scenario: ## 核对模拟器脚本与算法的每一步
	cd frontend && npm run check:scenario

check-views: ## 无头渲染六个视图并驱动主要交互（需要服务已在 $(PORT) 运行）
	cd frontend && npm run check:views

check: test check-scenario build ## 不依赖服务的全部检查
	@echo "通过：后端测试、模拟器脚本、前端类型检查与构建"

check-all: ## 全部检查，自行起停服务
	$(MAKE) extract
	$(MAKE) build
	$(MAKE) test
	$(MAKE) check-scenario
	@cd backend && cargo run --release -- serve --data ../$(DATA) --dist ../$(DIST) --port $(PORT) & \
	server_pid=$$!; \
	trap "kill $$server_pid 2>/dev/null" EXIT; \
	for i in $$(seq 1 40); do \
	  curl -sf -o /dev/null "http://127.0.0.1:$(PORT)/api/stats" && break; \
	  sleep 0.5; \
	done; \
	$(MAKE) check-views

fmt: ## Rust 代码格式化
	cd backend && cargo fmt

clean: ## 清掉构建产物（保留 data/ 与前端依赖）
	cd backend && cargo clean
	rm -rf frontend/dist frontend/.tmp
