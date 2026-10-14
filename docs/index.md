---
layout: home

hero:
  name: Robot Debug Desk
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
      link: https://github.com/phamstered/robot-debug-desk

features:
  - title: Mac 不装 ROS
    details: 桌面端通过 SSH 本地端口转发访问 Jetson 上只监听 127.0.0.1 的 Bridge，不加入 DDS。
  - title: Topics · Graph · Inspector
    details: Topic 发现与只读订阅、近似 rqt_graph 的拓扑图、Topic Inspector 原始 JSON / 元数据与 Image Canvas 预览。
  - title: URDF · 电机 · 轨迹
    details: Three.js Robot View、MIT JointCommand 面板、Joint4 标定（重力辨识 UI 见设计草案），以及 active 轨迹控制器下的 TCP 拖拽下发。
---

## 这是什么

**Robot Debug Desk**（仓库 [`phamstered/robot-debug-desk`](https://github.com/phamstered/robot-debug-desk)）是运行在 macOS 上的 ROS 2 Humble 调试与受控操作控制台，技术栈为 Tauri + Rust + React + Three.js。ROS Bridge 运行在 Jetson / Ubuntu 22.04；两端仅通过 SSH 隧道通信。

| | |
|---|---|
| **产品名** | Robot Debug Desk |
| **npm 包名** | `easy-debug`（历史名，尚未改代码） |
| **应用显示名** | Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`） |

## 快速入口

1. [架构概览](./architecture) — 数据路径与信任边界
2. [连接与 Bridge](./connect) — SSH、隧道、会话与默认 Profile
3. [功能概览](./features) — 模块说明、操作步骤与 HTML 流程图
4. [macOS 安装](./install) — `npm run install:mac`
5. [部署 Bridge](./deploy-bridge) — `npm run deploy:bridge`

详细行为与测试覆盖见 [基本功能与测试覆盖](./basic-features)；WebSocket 字段见 [Bridge 协议](./protocol)。设计中的全臂重力辨识 UI 见 [重力辨识（设计草案）](./gravity-identification)。

## 本机开发

```bash
npm install
npm run tauri dev
```

文档站点本地预览：

```bash
npm run docs:dev
```
