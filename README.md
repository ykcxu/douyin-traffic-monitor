# 抖音流量监控

一个最小可运行的 Node.js 项目，用作“抖音流量监控”的初始化版本。

当前仓库以项目设计和本地运行骨架为主，真实直播间名单保留在本地私有文件中，不进入版本控制。

## 使用

安装依赖（当前项目无额外依赖，可跳过）：

```bash
npm install
```

启动项目：

```bash
npm start
```

启动本地 API 服务：

```bash
npm run serve
```

启动直播采样 worker（循环采样）：

```bash
npm run worker:live
```

启动直播消息监听 worker（弹幕/点赞/礼物/进场）：

```bash
npm run worker:messages
```

初始化本地数据库：

```bash
npm run db:init
```

生成每日报告骨架：

```bash
npm run report:daily
```

执行一次直播间页面采样：

```bash
npm run sample:live
```

运行本地 smoke tests：

```bash
npm test
```

## 说明

- 项目目录：`douyin-traffic-monitor`
- 入口文件：`src/index.js`
- 本地私有监控目标：`data/monitor-targets.json`
- 可提交示例模板：`data/monitor-targets.example.json`
- 项目设计文档：`docs/project-design.md`
- 当前输出：启动后读取监控名单并打印统计摘要

## 当前工程骨架

- `src/config.js`：统一配置入口
- `src/core/target-loader.js`：监控目标加载与汇总
- `src/db/`：SQLite 初始化、Schema、Repository
- `src/services/`：启动、分析、报告生成逻辑
- `src/services/live-sample-service.js`：直播间页面采样与快照落库
- `src/services/comparison-service.js`：学科与竞品对比聚合输出
- `src/bridges/douyin_live_bridge.py`：抖音直播消息桥接（WebSocket 解码）
- `src/tasks/`：采样和分析任务注册表
- `src/scripts/`：建库、生成日报等命令行脚本
- `storage/app.db`：本地 SQLite 数据库文件
- `data/runtime/logs/`：本地运行日志

## 配置

- 复制 `.env.example` 中的变量到你的本地环境即可
- 当前支持：
  - `HOST`
  - `PORT`
  - `LIVE_SAMPLE_INTERVAL_SEC`
  - `LIVE_SAMPLE_BATCH_SIZE`
  - `PROFILE_SAMPLE_INTERVAL_SEC`
  - `ANALYSIS_INTERVAL_SEC`
  - `MESSAGE_MONITOR_ROOM_LIMIT`
  - `MESSAGE_BRIDGE_DURATION_SEC`
  - `PYTHON_BIN`
  - `DOUYIN_SPIDER_PATH`
  - `DY_LIVE_COOKIES`

## 当前已落地能力

- 监控目标本地私有加载
- SQLite 数据库初始化
- 监控目标同步到数据库
- 学科对比和竞品对比报告骨架
- 每日话术建议占位生成
- 高峰时段占位生成
- 本地日志输出
- 本地 API 对比接口（学科对比、内部 vs 竞品）
- 循环采样 worker
- 消息流监听 worker（入库 `live_messages`）

## API 参考

- `GET /health`
- `GET /api/summary`
- `GET /api/snapshots/recent?limit=20`
- `GET /api/compare/departments`
- `GET /api/compare/internal-vs-competitor`
- `GET /api/messages/recent?limit=50`

## 数据安全

- `data/monitor-targets.json` 已加入 `.gitignore`
- 真实直播间链接、主页链接、账号名单等敏感信息只保留在本地
- 仓库内只保留示例模板和设计文档
