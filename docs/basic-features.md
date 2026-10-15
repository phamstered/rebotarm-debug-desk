# Rebotarm Debug Desk 基本功能与测试覆盖

更新日期：2026-10-15

产品名：**Rebotarm Debug Desk** · 仓库：[`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)。npm 包名为 `rebotarm-debug-desk`；Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`），文档不在此处静默改代码侧显示名。

本文档记录当前已经实现的基本功能、运行边界以及对应的自动化单元测试。项目由 macOS Tauri 桌面端、React/Three.js WebView 和 Jetson ROS 2 Bridge 三部分组成。

面向操作的模块说明与流程图见 [功能概览](./features)；本文保留测试覆盖矩阵与更细的行为边界。

macOS 本机安装使用 `npm run install:mac`：先编译 release 版，再将
`Robot Console.app` 安装到 `/Applications`，更新失败时恢复原安装。

## 0. Jetson Bridge 部署脚本

- `npm run deploy:bridge`（`scripts/deploy-bridge.mjs`）用于把本地 `bridge/easy_debug_bridge` 同步到 Jetson colcon 工作区、执行 `colcon build`，并校验安装二进制与 `127.0.0.1:8765` 监听状态。
- 默认不同步删除远端 package 内多余文件；`--backup` 可在同步前打包远端副本；`--restart` 才重启 Bridge（避免把“已编译”当成“当前进程已更新”）。
- 配置有内置通用默认值（host `jetson`，远端 `easy_debug_bridge`、overlay `leader_follower/install/setup.bash`，均相对远端 `$HOME`；本地 package 相对仓库根目录），可用 flags / `BRIDGE_DEPLOY_*` 覆盖。远端路径可为绝对路径或相对 `$HOME`，拒绝 `~`、`.`/`..`、空段、以 `-` 开头的段和 shell 元字符。`npm run test:deploy` 覆盖参数解析、rsync 参数、远端脚本与校验输出解析，不要求真实 Jetson。

## 1. 连接与会话

- 首页 / 连接配置主表单只编辑 SSH 主机、用户名、端口、私钥；「高级」（默认折叠）编辑 ROS Domain 与 ROS 环境脚本。URDF / JointState / Command / Status Topic 与 TCP Link 用内置默认，界面不编辑；持久化仍写出这些键，旧 localStorage 字段会继续读入。
- 连接后可从全局工具栏重新打开连接配置；保存不会中断当前 SSH/Bridge 会话，新值在下次重连时生效。
- 默认 Profile：SSH 主机 `jetson`，ROS 环境脚本 `leader_follower/install/setup.bash`（相对远端 `$HOME`）。ROS 环境脚本路径同样拒绝 `~`、`.`/`..`、空段和以 `-` 开头的段。
- 自动迁移旧配置：旧 ROS setup 路径和 `/joint_states` 会迁移到当前默认值 `/stm32/joint_states`。
- 依次执行 SSH 检查、SSH 本地端口转发（会话）、WebSocket Bridge 连接，再确认 micro-ROS Agent；首页用步骤高亮与四段状态灯（SSH / Bridge / Agent / HardwareStatus）标出卡点。
- 连接失败展示可读中文原因与「复制错误」；成功 SSH 主机记入最近主机快捷回填。
- `ROS_DOMAIN_ID` 偏离默认或上次成功值时，状态条提示域名不匹配风险。
- Bridge 订阅默认 JointState Topic 后，收到首帧即视为 ROS 就绪（冒烟）；HardwareStatus 首帧点亮对应状态灯。
- 首选本地端口被占用时自动选择空闲端口，并在界面显示实际转发端口。
- 断开连接时关闭 WebSocket、SSH 隧道；电机命令流运行时先请求 DISABLE。断开按钮保持明显；无自动重连。
- 断开和重新连接时清空上一会话的 Topic 列表与采样、选中项、URDF、JointState、硬件/Agent/Controller 状态、错误及操作反馈；保留连接配置、最近主机、面板布局等用户偏好。
- Bridge 关闭时拒绝上一会话尚未完成的请求，并忽略旧 WebSocket 延迟到达的数据帧，避免污染新会话。
- Jetson Bridge 仅监听 `127.0.0.1`，通过 SSH 隧道访问。
- 连接后根据 Bridge `hello` 的 `bridge_version` / `bridge_build_id` 与本机期望值比对：不一致时提示升级（`deploy_bridge` → `deploy:bridge` 路径），可跳过；缺少 build id 时仅提示「无法确认版本」。升级不烧录 STM32、不同步 ros2-stack。

## 2. micro-ROS Agent 状态

- 读取 `micro-ros-agent-stm32h723.service` 的 systemd 状态。
- 显示 loaded/active/substate、PID、开机启用状态和服务描述。
- 连接后每 5 秒刷新，区分运行中、未运行和检查失败。

## 3. ROS Topic 浏览器

- 从 ROS graph 获取 Topic 名称和类型。
- 点击 Topic 后创建只读订阅，并以 JSON 查看最新消息。
- 显示累计消息数和平均接收频率。
- Topics 列表头部提供即时搜索框，可按 Topic 名称或消息类型进行大小写不敏感过滤，并显示匹配数/总数；过滤仅影响本地显示，不改变订阅状态。
- Topics 列表默认每 30 秒重新请求 ROS graph，也可通过标题栏刷新按钮立即刷新；自动刷新周期可在应用设置中配置为 5–300 秒。刷新失败时保留现有列表并显示原因。
- 页面导航只保留在左侧 Navigation，**Status** 为第一项（只读状态总览卡片网格），其后为 Topics、Monitor、Motor 和 Calibration；Robot View / Topic Graph 作为 Topics 中心面板标题栏内的局部 Tab。数值曲线在 Monitor 导航页。顶部工具栏不再重复品牌或导航。
- **Status** 页复用现有连接态：SSH/隧道端口、Bridge WS + hello 的 `bridge_version`/`bridge_build_id`（若有）、micro-ROS Agent（`check_micro_ros_agent`）、HardwareStatus（fault_code/mode）、JointState 冒烟与 Hz、`check_ros_controllers` 的 active 列表、ROS_DOMAIN_ID 提示；systemd Bridge 单元 journal 与 USB CDC 在无 API 时显示「未知」。只读，无一键升级全部或自动刷写 STM32。
- 顶部工具栏提供连接配置、全部刷新、实时显示暂停/恢复、rosbag 录制、诊断快照、重置布局和应用设置；右侧保留压缩连接状态灯（含 ROS 就绪 / Domain 提示）、连接名、隧道端口、micro-ROS Agent 状态和醒目断开按钮。
- Topics 页的 Topics、ROS Control、Inspector 三个区域可独立展开/收起；左右侧栏也可整列最小化并恢复，状态保存在本机。Topics 与 ROS Control 会自动使用另一面板释放出的高度。
- Topics/ROS Control 之间可上下拖动调整高度；左右侧栏边界可横向拖动调整宽度，面板尺寸会持久化到本机。分隔条支持键盘方向键微调。Topic 名称与类型悬停显示全称。
- Topics 下方显示 `/controller_manager` 当前加载的 ROS Control Controller、类型及 active/inactive 等状态，每 30 秒只读刷新。
- ROS Control 标题栏提供手动刷新按钮，与展开/收起按钮并列；手动与自动刷新具有并发保护。
- 点击 Controller 卡片会切换到 Topic Graph，按实际 ROS 关系聚焦关联节点、Topic 和连线。每个 Controller 可根据当前状态执行 Activate 或 Deactivate；操作通过 SSH 调用 Humble `ros2 control switch_controllers --strict`，完成后固定刷新一次列表并展示成功或错误信息。
- Controller 名称和操作类型在 Tauri/Rust 后端校验，拒绝包含 shell 特殊字符的输入。
- 兼容 Jetson 当前 Humble `ros2controlcli` 的超时参数类型缺陷：不显式传入 `--switch-timeout`，使用其内部浮点默认值，并由外层进程提供 10 秒超时保护。
- controller manager 服务不可用或查询超时时显示离线原因，不阻塞 Topic 浏览和其他功能。
- Bridge 可订阅 Jetson 当前 ROS 环境中已安装类型支持的消息类型。已知的基础消息保留原有字段格式；其余类型通过 ROS 2 运行时字段描述递归转换为 JSON，包括 `control_msgs/msg/JointTrajectoryControllerState` 的嵌套字段和数组。类型支持缺失或请求类型与已发现的 Topic 不符时显示具体错误。

## 4. Topic Graph、Inspector 与 Monitor

- Robot View 同级提供 Topic Graph Tab（DataGraph 已迁至 Monitor 导航页）。Topic Graph 展示 ROS Node、Topic，以及 Publisher/Subscriber 的有向连接关系，视觉语义与 `rqt_graph` 一致。
- Topic Graph 在打开时立即加载，默认每 30 秒自动刷新，也可点击“刷新 Graph”手动刷新；图变化不影响现有 Topic 数据订阅。
- Graph 使用确定性的力导向布局：ROS Node 为圆角矩形、Topic 为椭圆，使用与界面一致的蓝青/青绿色，连线保留发布/订阅方向；图形大小反映连接数。节点之间有斥力、连接有引力，并进行碰撞消除；画布适应可用尺寸，必要时可滚动。默认隐藏 Bridge 节点及其私有 Topic，可用“显示 Bridge”开关恢复；共享机器人数据 Topic 保留。
- 画布支持滚轮/按钮缩放、空白处拖拽平移、Fit 与 Reset；节点可拖动，手动位置在 Graph 刷新后仍保留（节点仍存在时）。连接线上用粒子动画示意数据流向与快慢（当前为占位流速：publish 快于 subscribe，尚未接真实 Hz）。
- 点击任意图形会高亮其一跳关联节点和连线、弱化其他拓扑；点击左侧 Topic 列表也会切到 Graph、滚动到对应 Topic 并聚焦。点击 Topic 图形创建只读订阅，点击 Node 图形显示其详情。
- 右侧 **Inspector** 以“数据 / 详情”Tab 区分：Topic 数据显示完整名称和原始 JSON，Image 显示 Canvas 预览与紧凑元数据；Topic 详情按需从 Bridge 获取发布者、订阅者、GID 和 QoS。选中 Node 时自动显示其发布、订阅、服务和客户端列表。订阅失败单独提示，不会中断 Graph 刷新。
- 在 JSON 中右键有限数值叶子、数值数组字段或数组元素，菜单列出当前存在的 Monitor **仪表盘（Dashboard）**；选择目标仪表盘后为每个字段创建 **Panel**（各含一张 Chart）并跳转 Monitor 页。数组字段展开为 `field[0..n]` 多个 Panel。
- **Monitor** 导航页：Grafana 式 **Dashboard → Panel → Chart**。多仪表盘（创建/重命名/删除，配置写入 localStorage `robot-console-monitor` v2 并在重启后恢复）；默认「Motor Torque」仪表盘含 **7 个可拖拽/缩放 Panel**（`effort[0..6]`，`react-grid-layout` 12 列，共享 30 秒时间窗与共享准星，Y 轴各自缩放）。支持暂停跟随（冻结采样+时间窗）、双击最大化、重置布局、锁定布局与紧凑排列（锁定/紧凑偏好持久化；最大化仅会话内）。旧版 `panels[].series[]` 标签页配置会在加载时迁移为仪表盘/面板。从 Inspector 加入字段会追加 Panel。全局「暂停显示」与 Monitor「暂停跟随」同源。
- Monitor Bag 回放：经 Tauri SSH 在 Jetson 执行 `ros2 bag play <path> --clock`，曲线仍走 Bridge 实时订阅；本机解析 bag / 下载 / 索引未实现。路径校验与录制相同（拒绝 `~`、`.`/`..`、shell 元字符等）。
- `sensor_msgs/msg/Image` Topic（包括 `/camera/color/image_raw`）在数据 Tab 使用 Canvas 实时预览，支持 rgb8、bgr8、rgba8、bgra8、mono8、mono16 及对应 OpenCV 8UC/16UC1 编码、行步长和大小端转换。
- Image 数据由 Bridge 使用 WebSocket 二进制帧全速传输，帧头保留 JSON 元数据、像素保持原始字节，避免 Base64 膨胀和大 JSON 解析；Canvas 使用浏览器动画帧合并绘制，不丢弃 Bridge 消息且不影响 Topic 频率统计。元数据展示尺寸、编码、step、时间戳与原始字节数但不展开二进制内容。
- Graph 可以展示 ROS graph 中的全部 Topic；实时内容解析要求对应消息类型支持已安装在运行中的 Bridge ROS 环境。64 位整数超过 JavaScript 安全整数范围时以十进制字符串传输，非有限浮点数转为 `null`。

## 5. URDF 与 Three.js

- 从配置的 `std_msgs/msg/String` Topic 获取 URDF XML。
- Bridge 对名称末段为 `/robot_description` 的 Topic 固定使用 `RELIABLE + TRANSIENT_LOCAL + KeepLast(1)` 订阅，不依赖 ROS graph 发现时序；即使 `robot_state_publisher` 仅在启动时发布一次，晚连接的上位机也能取得 DDS 保留的 URDF。
- 使用 Three.js、React Three Fiber 和 `urdf-loader` 渲染机器人。
- 保留 URDF `<visual>` 的内联或全局命名 RGBA 材质颜色；异步 STL、DAE、OBJ 网格挂载后再应用颜色，并保留网格纹理等材质属性。
- Robot View 使用平衡的环境光和方向光，避免中间色机械臂因过曝显示成白色。
- 根据 `sensor_msgs/msg/JointState` 的 name/position 驱动 URDF 关节；缺少的位置值按 0 处理。
- 通过 Bridge 获取 `package://` 资源，支持 STL、DAE、OBJ、PNG、JPG/JPEG；兼容 ROS 2 `--symlink-install` 产生的 package 内资源链接，并在跟随链接前拒绝绝对路径与 `..` 目录穿越。
- 解析 DAE 相对纹理路径，生成临时 Blob URL，并在资源释放时回收 URL。
- Bridge 对 package 资源先执行词法路径边界检查，再跟随 package 内的资源符号链接，禁止 URI 越过 package share 目录。
- 大型 URDF 网格采用顺序加载，避免多个 Base64 WebSocket 响应同时排队；单个资源使用 30 秒超时，并在失败提示中显示具体 `package://` URI。
- Robot View 的 URDF 错误与轨迹控制器状态使用同一个响应式 heads-up 网格排版，在常规和窄面板下不会互相覆盖。
- Tauri CSP 同时允许 Three.js 通过 `connect-src blob:` 获取 STL/DAE/OBJ Blob；网格解析失败时显示 Blob 路径和底层错误原因。

## 6. MIT 电机控制

- 左侧 Navigation 的 Motor 打开独立控制页面，默认提供 7 个关节控制行；收到更多 JointState 关节时会扩展列表，最多 32 个。
- 页面采用关节目标区和共享 MIT 参数/安全操作区的双栏布局；较窄窗口自动改为单栏，操作区在宽屏滚动时保持可见。
- 发布 Topic 默认为 `/stm32/joint_commands`，消息类型为 `JointCommand`。
- 默认模式为 TRACK，默认 `Kp=8`、`Kd=2`。
- 支持 HOLD、TRACK、RETURN、DISABLE 四种 `JointCommand.mode`。
- 多电机列表：每个关节可单独使能；Position 提供滑块与数值输入，行程 min/max 默认为 `±0.35 rad` 且可按关节配置（仅约束滑块，不做 Bridge 限幅）。
- 仅对用户使能的关节发送非零命令通道，并通过 `active_joint_mask` 告知 Bridge；未使能通道保持 0。
- Velocity、Kp、Kd、Effort 在 v1 仍为全局共享；Effort 限制为 `[-1, 1] Nm`，所有字段必须为有限数字。Position / Velocity / Kp / Kd 不由上位机限幅。
- 允许自然输入负数、小数、输入中的末尾小数点以及逗号小数。
- “使用当前位置”会把各关节反馈写入对应 Position；这是唯一自动写入 Position 的操作。
- 安全确认在一次连接会话中只需勾选一次；DISABLE 后不会自动取消。
- TRACK 等非 DISABLE 命令预检成功后以 20 Hz 连续发送；至少使能一个电机。
- 离开 Motor 页面时停止定时发送；若正在发送或预检尚未完成，会额外请求 DISABLE，避免隐藏页面继续控制。
- Bridge 要求 command subscriber、最新 status/joint feedback（<1 s），且请求掩码全部落在固件 `active_joint_mask` 内；STM32 fault 由界面展示，最终执行安全由固件裁决。
- DISABLE 将控制字段清零并发布 3 帧，各帧使用连续递增的 sequence，避免 `STALE_SEQUENCE`。
- 显示 STM32 fault code 0–11 的英文名称和中文原因；未知编号显示 UNKNOWN。

> STM32 固件仍有自己的最终限幅。例如当前固件 Position 上限约为 `±0.35 rad`，超出可能报告 `FAULT 3 · COMMAND_LIMIT`。界面默认行程与此对齐，但用户可放宽滑块范围。

## 7. WebSocket 协议

- 使用 UTF-8 JSON 文本帧。
- 支持 hello（含 `bridge_version` / `bridge_build_id` / `ros_distro`）、topics、graph、topic_info、node_info、subscribe、resource、joint_command、trajectory_command 操作。
- request 使用 UUID 与 response/error 关联，超时或 Bridge error 会拒绝 Promise。
- Bridge 断开会通知界面进入连接失败状态。
- 完整字段参见 [protocol.md](protocol.md)。

## 8. App 品牌与图标

- 用户面向产品名为 **Rebotarm Debug Desk**；当前代码侧应用显示名（Tauri `productName` / Dock / `.app`）仍为 **Robot Console**。
- App Logo 使用简化双关节机械臂、金属材质和单一青色状态光，适配深色界面与 macOS Dock 小尺寸显示。
- 设计源文件位于 `assets/logo/robot-console-icon.png`，应用内品牌图和 Tauri macOS Bundle 共用同一视觉资源。

## 9. Joint4 重力标定

- 左侧 Calibration 页面订阅 `/joint4_calibration_controller/status`，展示关节位置、速度、模型/修正/所需力矩、参考位置、稳定时间与保护状态。
- 标定流程通过受限的 `std_srvs/srv/Trigger` 服务执行 Begin、Capture、Release、Fit 和 Reset，界面不直接写入 URDF 或控制参数。
- Capture 仅在 Controller active、状态新鲜、姿态保持稳定且确认手部支撑已撤掉后开放。
- `safety_fault` 会锁定采样和拟合；托住 joint4 后可执行 Release 清除新版 Controller 的故障锁存。对旧版 Controller，姿态已释放且速度不超过 0.05 rad/s 时允许重新 Begin，以当前安全位置重建参考，避免界面与 Controller 互相锁死。
- 标定采样和拟合结果可保存为本机 JSON/CSV 审计报告。

## 10. TCP 拖拽轨迹下发

- Robot View 从 URDF 解析关节链并定位 TCP（夹爪）link：连接配置里的 `tcpLink` 优先，留空时在叶子 link 中按命名特征（tool0/tcp/gripper/ee_link/flange 等）加链深度自动挑选，并在视图右上角展示实际使用的 link。
- 仅当 `/controller_manager` 存在 active 的轨迹控制器时开放拖拽；识别规则为类型 `joint_trajectory_controller/JointTrajectoryController` 优先、名称含 traj 次之。ROS Control 列表会用“轨迹”标记对应 Controller，Robot View 右上角显示其名称和 `/…/joint_trajectory` Topic。
- 拖拽手柄跟随 TCP link 的世界位姿，并保持屏幕上的恒定尺寸；按住后鼠标移动映射到过 TCP 的正交平面（相机正对平面），拖拽期间暂停轨道相机；Esc 取消并把模型恢复到实时反馈位姿。
- 拖拽过程按帧求位置逆解：有限差分雅可比 + 自适应阻尼最小二乘，关节限位钳制，单次下降卡住时做确定性随机重启。仅做位置求解，TCP 姿态保持不变；只有残差不超过 5 mm 才允许下发，下发成功时会把实际残差一并展示，避免暗示夹爪精确落在目标点上。
- 正运动学和逆解保留 TCP 链上的 fixed joint 与工具偏移，避免夹爪长度被忽略；轨迹只包含可控关节，JointState 中的其他关节保持当前反馈值，因此轨迹携带的关节集合与控制器一致。拖拽期间预览位姿不被实时 JointState 覆盖。
- 松开鼠标时按最新 JointState 重算一次并下发 `trajectory_msgs/msg/JointTrajectory`：第 1 点为当前反馈位置（短暂停留），第 2 点为目标位置，执行时长按最大关节位移在 0.4–6 s 内估算。
- 下发失败或 IK 未收敛时把模型恢复到反馈位姿并在视图内展示原因，不隐藏失败。
- Bridge 只向以 `/joint_trajectory` 结尾且仅含字母数字下划线斜杠的 Topic 发布，并要求该 Topic 已有订阅者；关节名重复、点数/长度不一致、非有限数值以及非严格递增的 `time_from_start` 都会被拒绝。

## 11. 全局工具栏、诊断与 rosbag

- “暂停显示”只冻结 WebView 对 Topic、JointState 和硬件状态消息的消费，不断开 Bridge，也不停止后台 rosbag；恢复后从下一条消息继续更新。
- “全部刷新”同时刷新 Topics 和 ROS Control 列表，并复用各自的并发保护。
- “开始录制”通过受约束的 Tauri SSH 命令在 Jetson 执行 `ros2 bag record -a`，输出到 `$HOME/robot-console-bags/robot-console-<时间>`；PID 和输出路径记录在 `$HOME/.cache/robot-console/`。停止时先发送 SIGINT 以便 rosbag 完成索引，超时后才使用 SIGTERM。
- rosbag PID 在停止和状态检查前同时验证进程存在且命令行为 `ros2 bag record`，避免对复用 PID 的无关进程发送信号。断开 Rebotarm Debug Desk 不会自动停止录制；重新连接会恢复显示远端录制状态。
- “诊断快照”保存本机 JSON，包含脱敏后的连接信息、Topics、Controller、micro-ROS Agent、HardwareStatus、选中 Topic 和消息统计；不写入 SSH 私钥路径，大消息预览限制为 4 KiB，文件上限为 5 MiB。
- “重置布局”恢复 Topics 页默认左右宽度、Topics/ROS Control 分割比例并展开侧栏和数据面板；“设置”可配置自动刷新周期和诊断快照是否包含消息摘要。

## 12. 单元测试覆盖矩阵

| 功能域 | 覆盖内容 | 测试位置 |
|---|---|---|
| 配置 | 默认值、损坏数据回退、旧路径/Topic 迁移 | `src/appLogic.test.ts` |
| 面板 | 默认/持久化状态、三个内容面板与左右侧栏收起、宽高分隔条和尺寸边界 | `src/appLogic.test.ts`、`src/layoutLogic.test.ts`、`src/App.test.tsx` |
| 工具栏 | 导航职责分离、中心局部 Tab（Robot View / Topic Graph）、全部刷新、实时暂停/恢复、连接配置、设置和布局重置 | `src/App.test.tsx`、`src/toolbarLogic.test.ts` |
| rosbag/诊断 | 安全命令生成、PID/状态解析、录制启停、诊断脱敏/预览上限/文件校验与导出 | `src-tauri/src/lib.rs`、`src/toolbarLogic.test.ts`、`src/App.test.tsx` |
| 连接流程 | SSH→会话→Bridge→Agent、状态灯/步骤/可读错误/最近主机、JointState 冒烟、实际端口、基础订阅、重连会话数据清理、版本检查与升级提示 | `src/App.test.tsx`、`src/appLogic.test.ts`、`src/bridge.test.ts` |
| Agent | systemd 属性解析、异常 PID | `src-tauri/src/lib.rs` |
| SSH 输入 | 用户名目标、setup 路径和 Topic 格式校验 | `src-tauri/src/lib.rs` |
| 本地端口 | 首选端口及占用时自动回退 | `src-tauri/src/lib.rs` |
| Topic | 发现、选择订阅、消息路由、计数和频率、手动/30 秒自动刷新 | `src/App.test.tsx`、`src/appLogic.test.ts` |
| Topic Graph | ROS 图请求、自适应引力布局、画布缩放/平移/Fit、节点拖动、占位粒子流速、Bridge 过滤、Controller 聚焦、节点订阅和刷新 | `src/bridge.test.ts`、`src/topicGraphLogic.test.ts`、`src/TopicGraph.test.tsx`、`src/App.test.tsx` |
| Inspector | Topic/Node 详情、完整 Topic 名称、JSON 右键字段、图像预览、订阅失败提示 | `src/TopicInspector.test.tsx`、`src/App.test.tsx` |
| Monitor / DataGraph | Dashboard/Panel CRUD、网格拖拽布局、共享准星、暂停跟随/冻结窗口、最大化、重置/锁定/紧凑、v1→v2 迁移、转矩 7 Panel、路径解析与数组展开、30s 窗口、Jetson bag play | `src/monitorLogic.test.ts`、`src/MonitorPage.test.tsx`、`src/dataGraphLogic.test.ts`、`src/DataGraph.test.tsx`、`src/App.test.tsx`、`src-tauri` rosbag play 测试 |
| 图像 Topic | Image WebSocket 二进制全速传输、动画帧合并绘制、RGB/BGR/RGBA/BGRA/Mono8/Mono16 转换、step/大小端、Canvas 预览及紧凑元数据 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`bridge/easy_debug_bridge/test/test_image_topic.py`、`src/bridge.test.ts`、`src/imageTopicLogic.test.ts`、`src/RosImagePreview.test.tsx`、`src/TopicInspector.test.tsx` |
| 通用 Topic 解码 | 已安装消息类型的嵌套字段、数组、时间与大整数，ControllerState Inspector 路由、错误类型拒绝 | `bridge/easy_debug_bridge/test/test_topic_json.cpp`、`bridge/easy_debug_bridge/test/test_generic_topic.py`（ROS 集成）、`src/App.test.tsx` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Controller 状态展示、Activate/Deactivate、操作后刷新、手动/30 秒自动刷新 | `src-tauri/src/lib.rs`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | transient-local 晚加入 QoS、symlink-install package URI 与目录穿越防护、相对纹理、Base64、JointState 映射、内联/命名材质颜色、异步网格挂载后着色、错误/轨迹提示非重叠布局 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`src/urdfLogic.test.ts`、`src/ViewerHeadsUp.test.tsx` |
| 电机输入 | 默认 TRACK/Kp/Kd、多电机使能掩码、行程默认 ±0.35、小数输入、有效数值和 Effort 限制 | `src/motorLogic.test.ts` |
| 电机交互 | 独立导航页、7 个默认关节、安全确认、每关节滑块/使能、使用当前位置、20 Hz 流、切页 DISABLE | `src/App.test.tsx`、`src/MotorControl.test.tsx` |
| Fault | 固件 0–11 映射及未知 fault | `src/motorLogic.test.ts`、`src/MotorControl.test.tsx` |
| Bridge 命令 | mode、ARMED、有限值、Effort、关节掩码解析/校验及 sequence 分配 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |
| Joint4 标定 | 状态解析、安全门控、fault 恢复、Trigger 服务白名单、报告校验与导出 | `src/joint4CalibrationLogic.test.ts`、`src/Joint4CalibrationPage.test.tsx`、`src-tauri/src/lib.rs` |
| 运动学 | URDF 关节链/限位解析、TCP link 解析、正运动学、位置逆解收敛与限位钳制、拖拽坐标换算与射线求交 | `src/kinematicsLogic.test.ts` |
| 轨迹规划 | 轨迹控制器识别与优先级、Topic 命名、时长估算、轨迹点构造、fixed joint/TCP 工具偏移、链关节改写与非链关节保持 | `src/trajectoryLogic.test.ts` |
| 轨迹下发 | 松手下发（成功/IK 未收敛/无 JointState/send 失败）、未激活拒发、active 控制器下发 JointTrajectory、Controller“轨迹”标记 | `src/trajectoryLogic.test.ts`、`src/App.test.tsx` |
| Bridge 轨迹 | Topic 白名单、关节名/点数/长度/有限值/时间递增校验、错误文案、Duration 拆分 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |
| macOS 安装 | release 构建后安装到 `/Applications`、失败回滚原安装 | `scripts/install-macos-app.node-test.mjs` |
| Bridge 部署 | 参数解析、rsync 参数、远端脚本与校验输出解析 | `scripts/deploy-bridge.node-test.mjs` |

## 13. 测试命令

每次功能变更必须执行：

```bash
npm test
npm run build
```

`npm test` 顺序执行：

1. `npm run test:frontend`：Vitest + jsdom + Testing Library。
2. `npm run test:rust`：Tauri/Rust 原生单元测试。
3. `npm run test:bridge`：不依赖 ROS 安装的 Bridge 核心 C++ 单元测试。
4. `npm run test:install`：macOS `install:mac` 安装脚本单元测试。
5. `npm run test:deploy`：Bridge 部署脚本（参数、rsync、校验解析）单元测试。

Jetson、Fast DDS、micro-ROS Agent 和 STM32 属于外部进程/硬件边界，不能由本机单元测试替代。涉及这些边界的变更还需执行 ROS 2 `colcon test`、隔离测试 Topic 或安全的 DISABLE 验证，但外部验证不能取代上述全量单元测试。
