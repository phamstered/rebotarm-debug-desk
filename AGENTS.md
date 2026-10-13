# Robot Debug Desk 开发规范

本文件适用于整个仓库。**Robot Debug Desk**（仓库 [`phamstered/robot-debug-desk`](https://github.com/phamstered/robot-debug-desk)）是运行在 macOS 的 Tauri/Rust + React/Three.js 上位机；ROS 2 Humble Bridge 运行在 Jetson/Ubuntu 22.04。Mac 不直接加入 DDS，桌面端通过 SSH 隧道访问 Jetson 上只监听 `127.0.0.1` 的 WebSocket Bridge。开始修改前先读相关的 `README.md`、`docs/architecture.md`、`docs/protocol.md` 和 `docs/basic-features.md`。用户文档站点（VitePress / GitHub Pages）：[https://phamstered.github.io/robot-debug-desk/](https://phamstered.github.io/robot-debug-desk/)。本地预览：`npm run docs:dev`；构建：`npm run docs:build`。

## 1. 变更范围与代码位置

- 前端页面和会话编排在 `src/App.tsx`；可复用的输入、布局、图、URDF、运动学、轨迹及图像处理逻辑放在对应的 `src/*Logic.ts`，避免继续堆积到页面组件中。
- 需要本机文件、进程或 SSH 权限的操作放在 `src-tauri/src/lib.rs`；ROS 订阅、资源读取和消息发布放在 `bridge/easy_debug_bridge`。WebView 不直接执行任意远端命令，Mac 不依赖 ROS 2 安装。
- 前端 ↔ Bridge 的字段或语义变更，同步更新 `src/types.ts`、Bridge 请求/响应处理、两侧测试和 `docs/protocol.md`。未知操作、消息类型和无效输入返回明确错误。
- 功能行为变更同步更新 `docs/basic-features.md`；改变数据路径、信任边界或部署方式时同步更新 `docs/architecture.md` / `README.md`。文档只描述已实现行为。
- 保留用户已有的工作树变更；只提交任务相关文件。不要顺手重写生成文件、锁文件或 Jetson 工作区中的其他扩展。

## 2. 连接、数据与界面

- SSH、隧道、WebSocket 和 ROS Bridge 是不同状态；连接失败展示具体阶段与原因。首选本地端口被占用时使用实际选出的端口，不假定 `18765` 一定可用。
- 断开或重连时清除上一会话的 Topic、采样、URDF、JointState、控制器/硬件状态、错误和未完成请求；保留连接配置与布局偏好。异步响应不能污染新连接。
- ROS QoS 按发布端兼容性选择；`/robot_description` 晚加入订阅保持 `RELIABLE + TRANSIENT_LOCAL + KeepLast(1)`。变更 QoS 时检查真实发布端的 `ros2 topic info -v`。
- 高速 Image Topic 保持二进制 WebSocket 数据路径，前端按动画帧合并绘制；不要让 Base64 大 JSON 或绘制频率限制 Bridge 接收速率。
- URDF 的 `package://` 资源先检查 URI 的词法路径边界，再跟随 ROS `--symlink-install` 的资源链接；保留材质颜色、纹理、Blob URL 回收和可读的单个资源错误。最终文件指向源码树不代表合法 mesh 越界。
- 页面导航、面板局部 Tab 和全局工具栏各司其职；新增提示框、浮层和可调整面板要检查常规及窄尺寸下的遮挡与溢出。手动刷新、定时刷新和耗时操作要有并发保护及状态反馈。

## 3. 控制指令安全边界

- 电机、Controller、标定和轨迹功能有物理后果。沿用现有确认、反馈新鲜度、订阅者、Controller active、关节限位和故障显示等安全门；不要为通过测试删除或弱化这些条件。
- 非 DISABLE 的 JointCommand 需经安全确认；DISABLE 保持随时可用、控制字段清零，并为每一帧分配新的 sequence。序列号与硬件反馈同步，避免 `STALE_SEQUENCE`。
- 控制模式、默认值和限幅以当前消息定义与固件行为为准；不要在 UI 额外限制 Position、Velocity、Kp、Kd。发送数值须为有限值，保留现有 Effort 限制。
- 轨迹只发送到已激活的 `JointTrajectoryController` 的 `/joint_trajectory`；Bridge 继续校验 Topic 白名单、关节名、点数、数组长度、有限值和递增时间。IK 未收敛或缺少新鲜 JointState 时拒绝下发并显示原因。
- 自动化测试使用隔离 Topic / ROS_DOMAIN_ID 或模拟数据。真实电机动作须先满足现场安全确认，不用生产机械臂验证一般代码改动。

## 4. 强制测试与验证

**所有功能的变更，都需要执行所有单元测试并保证通过。**

- 完成任何功能新增、修改、修复或重构后，必须在项目根目录执行 `npm test`。它应完整运行前端 Vitest、Tauri/Rust、Bridge 核心 C++、安装脚本测试和 Bridge 部署脚本测试；定向测试只能用于开发定位，不能代替最终全量测试。
- 任一单元测试失败时不得声明完成；不得删除、跳过或弱化有效断言。生产行为变化须新增或更新能覆盖该行为及失败边界的测试，并更新 `docs/basic-features.md`。
- 涉及 TypeScript/React 或打包配置的变更，在全量测试通过后执行 `npm run build`。涉及 Tauri 原生打包时运行 `npm run tauri build`；需要安装到本机时使用 `npm run install:mac`，并核对 `/Applications/Robot Console.app`（当前代码侧显示名仍为 Robot Console；产品文档名称为 Robot Debug Desk）。
- 涉及 Jetson Bridge 的变更，在可用环境中执行 ROS 2 `colcon build`、`colcon test`，并用隔离 Topic 或真实资源请求验证受影响路径。若环境限制导致 `colcon test` 无法启动，可运行构建目录中的 CTest，但须记录限制，不能称为完整 `colcon test` 通过。优先用 `npm run deploy:bridge` 部署，不要 ad-hoc 覆盖远端 package。
- 高频图像、URDF 资源、QoS、SSH 端口和界面布局等问题，单元测试之外还要按问题性质做端到端或视觉验证，记录实际验证对象、命令和结果。

```bash
npm test
npm run build
```

分层入口仅用于定位：`npm run test:frontend`、`npm run test:rust`、`npm run test:bridge`、`npm run test:install`、`npm run test:deploy`。

```bash
npm run test:frontend
npm run test:rust
npm run test:bridge
npm run test:install
npm run test:deploy
```

## 5. Jetson Bridge 部署（脚本优先）

仓库中的 `bridge/easy_debug_bridge` 与 Jetson colcon 工作区（如 `/home/<jetson-user>/easy_debug_bridge`，由 `$BRIDGE_DEPLOY_REMOTE` 指定）可能不一致。**不要**用 ad-hoc SSH/`scp`/`rsync` 整目录覆盖远端 package，也不要把 “colcon 成功” 当成 “当前进程已更新”。

统一使用：

```bash
npm run deploy:bridge -- --dry-run
npm run deploy:bridge -- --backup
npm run deploy:bridge -- --skip-sync --skip-build --restart
```

脚本：`scripts/deploy-bridge.mjs`。目标为 SSH host `<ssh-host>`，远端根目录 `/home/<jetson-user>/easy_debug_bridge`（同步到 `src/easy_debug_bridge/`），ROS overlay `<ros-overlay>/install/setup.bash`，端口 `8765`（内置默认值来自维护者环境，请按你的机器用 flags 或 `BRIDGE_DEPLOY_*` 覆盖）。可用 `--host` / `--remote` / `--ros-setup` / `--port` 或 `BRIDGE_DEPLOY_*` 覆盖。默认不加 rsync `--delete`，保留远端自定义消息/扩展。

部署后校验清单（脚本默认打印）：

1. `ros2` 解析到的 `bridge_node` 是否位于远端 `install/` 树
2. `/proc/<pid>/exe` 是否与解析到的安装二进制一致
3. 是否监听 `127.0.0.1:8765`
4. 不一致时必须显式 `--restart` 才会替换进程；不要手动 `pkill` 误伤其他节点
5. 桌面端重连或 `node scripts/smoke-bridge.mjs <localPort>`

阶段失败标注 `ssh` / `compare` / `backup` / `sync` / `build` / `verify` / `restart`。`npm run test:deploy` 不要求真实 Jetson；现场可达时再跑完整 deploy + `--restart`。

对 `package://`、QoS、图像速率等曾出现过“本机测试通过但现场仍失败”的问题，用正在运行的 Bridge 发起实际请求，并保留目录穿越等负例验证。远端操作只触及明确目标；验证新进程正常后再清理临时进程与隧道，不要误停其他 ROS 节点或隔离测试 Bridge。

## 6. Git 与交付

- 修复 GitHub 仓库问题时，先创建或确认 Issue，再在独立分支实现、测试、提交和推送，PR 正文写 `Closes #<编号>`。PR 留给用户人工审核，不自行合并或启用自动合并。
- 交付时说明改了什么、为何这样改、执行了哪些验证，以及尚未验证的硬件/环境边界。不要把“已编译”与“已安装”“Jetson 已部署”“当前进程已更新”混为一谈。
- CI 失败要读取对应运行日志并指出实际失败步骤；本地测试通过不能替代 CI 结果。
