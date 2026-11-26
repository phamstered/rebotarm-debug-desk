# Terminal 全页面检查表

控制与操作日志只有一个显示容器：应用主窗口或当前独立窗口最底部的 `Terminal`。嵌入原生页面通过事件打开主窗口的面板；拆出/恢复窗口打开自己的面板。每个面板读取原生共享历史，筛选与阅读位置独立。

## 页面与数据路径

| 页面 / 功能 | Terminal 来源与生产路径 | 页面保留内容 |
| --- | --- | --- |
| 连接、部署、离线入口 | App 的 Connection/System/Deploy/Window；原生部署事件、任务与恢复事件 | 当前连接阶段、单行失败原因、重试操作 |
| Status | App 的 Controller/Connection；共享硬件、连接、任务状态由专用状态模型显示 | 状态卡、健康与故障、跳转控制页 |
| 控制模式 / Manager | controllerManagerLogic、ArmModeWorkflow → Controller；原生 Task；原生 ROS 文件增量采集 | Manager 实际状态、控制器列表、模式状态、运行步骤、确认及停止 |
| Topics / Graph / Inspector | App、TopicGraph、TopicInspector → Topics | Topic 原始数据、图、QoS、当前订阅状态 |
| Motion / Robot View | positionMotionLogic、原生 MotionLogs → Motion；URDF/Camera；VisualPickPanel → Motion | 三维场景、执行就绪状态、安全门禁、运动取消 |
| Motion / 姿态与动作组 | PositionPage、SavePoseDialog、MotionGroupsPage → Motion | 编辑表单、未保存状态、输入校验、结构化执行报告 |
| Monitor / rosbag | MonitorPage、App → Monitor/Rosbag；原生 bag 任务事件 | 曲线、回放状态、历史窗口丢失提示、路径校验 |
| Motor | MotorControl → Motor；原生控制任务 → Task | 固件读回、模式故障、参数校验、停止确认、DISABLE |
| 数据采集 | OperationLogNotice → Collection；原生采集器日志尾部及 Episode 任务 | 帧数、FPS、Episode 状态、录制门禁与确认 |
| 手眼（在线与离线） | OperationLogNotice → Handeye；原生本地任务事件 | 标定板/样本、图像、矩阵与误差结果、配置校验 |
| 重力辨识 | OperationLogNotice 与变化的反馈文字 → Gravity；原生 Task | 阶段、数值反馈、参数/RMSE/YAML 结果、Abort 与安全规则 |

原始 ROS 输出含 Teleop、Trajectory / VLA、示教、MoveIt、Controller、RealSense；读取源由原生白名单限定。页面关闭、切页和 Terminal 折叠不会停止原生采集。高频关节、图像及标量反馈不会逐帧写入文字日志。

原有 `ControlLogViewer`、`MotionTerminal`、`DeployProgressLog` 入口现仅跳转统一 Terminal；前两者不再发起独立读取或渲染日志。部署在浏览器预览环境下保留行发布适配器，原生环境复用后台采集。

## 验证映射

- `OperationLogNotice.test.tsx`：完整输出只出现在 Terminal；页面卸载后历史保留；独立手眼窗口的入口不会修改主窗口筛选。
- `Terminal.test.tsx`：隐藏/折叠后继续读取、来源和会话过滤、暂停跟随、分页与虚拟列表、导出筛选/会话、原始源文件下载、错误/取消处理、旧机器人/断线/会话变化后的下载隔离。
- `MotionPage.test.tsx`：默认布局无本地日志分支；报告、切页、专注不重建场景，也不重置 Terminal 的筛选/滚动；隐藏页面期间仍能收到 ROS 输出。
- `positionMotionLogic.test.tsx`：浏览器 Motion 日志汇入共享历史；游标不重复发布；断线前的旧回调不能写入新上下文。
- Motor、DataCollection、GravityIdentification、Monitor、MotionGroups 页面回归继续验证控制请求、任务门禁与状态，原先页面文本断言改为检查本测试产生的实际 Terminal 记录。
- Rust `terminal.rs` / `control_logs` 测试覆盖共享任务会话绑定、保留预算、脱敏、源文件游标/轮转/截断、归档与下载白名单。

视觉验证使用真实页面组件和模拟消息：控制、Motor、数据采集、手眼、重力辨识、Motion 六个页面在 1440×900 和 900×620 下切换，检查唯一日志容器、原始消息不出现在页面、无横向溢出；另检查独立窗口路由。不以模拟数据宣称真实机械臂或 Jetson 部署通过。完整测试入口为 `npm test` 和 `npm run build`。
