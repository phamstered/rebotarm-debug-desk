---
layout: home

hero:
  name: Rebotarm Debug Desk
  text: ROS 2 调试与受控操作控制台
  tagline: macOS Tauri 桌面端 · Jetson WebSocket Bridge · 仅经 SSH 隧道通信
  actions:
    - theme: brand
      text: 架构概览
      link: /architecture
    - theme: alt
      text: 连接与 Bridge
      link: /connect
    - theme: alt
      text: 功能概览
      link: /features
    - theme: alt
      text: GitHub
      link: https://github.com/phamstered/rebotarm-debug-desk

features:
  - title: Mac 不装 ROS
    details: 桌面端通过 SSH 本地端口转发访问 Jetson 上只监听 127.0.0.1 的 Bridge，不加入 DDS。
  - title: Topics · Graph · Inspector
    details: Topic 发现与只读订阅、近似 rqt_graph 的拓扑图、Inspector 原始 JSON / 元数据与 Image Canvas 预览。
  - title: Robot View · 点云 · 姿态库
    details: Three.js 视图叠加左腕 RGBD 彩色点云；姿态库保存实测关节，解锁后由 MoveIt /move_action 执行。HOME 锁定为当前 SRDF。
  - title: 电机 · 标定 · 诊断
    details: MIT JointCommand、Joint4 标定，以及重力辨识页（Desk/Bridge 已接，实机 E2E 仍待现场）。运动抖动用只读采集脚本离线分析。
---

## 未连接时的首页

![连接页：SSH 主机、端口、私钥，以及连接 Jetson、管理姿态库、管理动作组](/screenshots/connect.png)

窗口标题是 **Robot Console**。未连接时只有这一张卡片：SSH 主机默认 `jetson`，端口 `22`，用户名和私钥可留空以使用 `~/.ssh/config`。按钮是「连接 Jetson」「管理姿态库」「管理动作组」。此图在没有 Jetson 的环境截取。

## 这是什么

**Rebotarm Debug Desk**（仓库 [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)）是运行在 macOS 上的 ROS 2 Humble 调试与受控操作控制台，技术栈为 Tauri + Rust + React + Three.js。ROS Bridge 运行在 Jetson / Ubuntu 22.04；两端仅通过 SSH 隧道通信。

| | |
|---|---|
| **产品名** | Rebotarm Debug Desk |
| **npm 包名** | `rebotarm-debug-desk` |
| **应用显示名** | Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`） |

## 快速入口

1. [架构概览](./architecture) — 数据路径与信任边界
2. [连接与 Bridge](./connect) — SSH、隧道、会话与默认 Profile
3. [功能概览](./features) — 模块说明、操作步骤与 HTML 流程图
4. [姿态库与 MoveIt2](./positions) — 保存姿态、锁定 HOME、会话解锁后执行与取消
5. [运动诊断](./motion-diagnostics) — Jetson 只读采集与离线抖动分析
6. [macOS 安装](./install) — `npm run install:mac`
7. [部署 Bridge](./deploy-bridge) — `npm run deploy:bridge`
8. [TODO / 待办列表](./todo) — 已讨论、尚未完成验收的事项

详细行为与测试覆盖见 [基本功能与测试覆盖](./basic-features)；WebSocket 字段见 [Bridge 协议](./protocol)。全臂重力辨识（Desk Bridge/UI 就绪，stack orchestrator E2E pending）见 [重力辨识](./gravity-identification)。

## 本机开发

```bash
npm install
npm run tauri dev
```

文档站点本地预览：

```bash
npm run docs:dev
```
