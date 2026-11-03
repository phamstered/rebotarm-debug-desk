# Rebotarm Debug Desk 基本功能与测试覆盖

更新日期：2026-10-16

产品名：**Rebotarm Debug Desk** · 仓库：[`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)。npm 包名为 `rebotarm-debug-desk`；Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`），文档不在此处静默改代码侧显示名。

本文档记录当前已经实现的基本功能、运行边界以及对应的自动化单元测试。项目由 macOS Tauri 桌面端、React/Three.js WebView 和 Jetson ROS 2 Bridge 三部分组成。

面向操作的模块说明与流程图见 [功能概览](./features)；本文保留测试覆盖矩阵与更细的行为边界。

macOS 本机安装使用 `npm run install:mac`：先编译 release 版，再将
`Robot Console.app` 安装到 `/Applications`，更新失败时恢复原安装。

## 0. Jetson Bridge 部署脚本

- `npm run deploy:bridge`（`scripts/deploy-bridge.mjs`）用于把本地 `bridge/easy_debug_bridge` 同步到 Jetson colcon 工作区、执行 `colcon build`，并校验安装二进制与 `127.0.0.1:8765` 监听状态。
- 默认不同步删除远端 package 内多余文件；`--backup` 可在同步前打包远端副本；`--restart` 才重启 Bridge（避免把“已编译”当成“当前进程已更新”）。
- 配置有内置通用默认值（host `jetson`，远端 `easy_debug_bridge`、overlay `Project/rebotarm-ros2-stack/install/setup.bash`，均相对远端 `$HOME`；本地 package 相对仓库根目录），可用 flags / `BRIDGE_DEPLOY_*` 覆盖。远端路径可为绝对路径或相对 `$HOME`，拒绝 `~`、`.`/`..`、空段、以 `-` 开头的段和 shell 元字符。`npm run test:deploy` 覆盖参数解析、rsync 参数、远端脚本与校验输出解析，不要求真实 Jetson。

## 1. 连接与会话

- 首页 / 连接配置主表单只编辑 SSH 主机、用户名、端口、私钥；「高级」（默认折叠）编辑 ROS Domain 与 ROS 环境脚本。URDF / JointState / Command / Status Topic 与 TCP Link 用内置默认，界面不编辑；持久化仍写出这些键，旧 localStorage 字段会继续读入。
- 连接后可从全局工具栏重新打开连接配置；保存不会中断当前 SSH/Bridge 会话，新值在下次重连时生效。
- 默认 Profile：SSH 主机 `jetson`，ROS 环境脚本 `Project/rebotarm-ros2-stack/install/setup.bash`（相对远端 `$HOME`）。旧 `leader_follower` Profile 会迁移到新默认路径；自定义路径保留。ROS 环境脚本路径同样拒绝 `~`、`.`/`..`、空段和以 `-` 开头的段。
- 本机与 Jetson 的 ROS stack 工作区使用 `Project/rebotarm-ros2-stack`；旧 `Project/leader_follower` 保留为指向新目录的兼容链接，以便已生成的 ROS overlay、脚本和现有绝对路径继续解析。
- 自动迁移旧配置：旧 ROS setup 路径和 `/joint_states` 会迁移到当前默认值 `/stm32/joint_states`。
- 依次执行 SSH 检查、SSH 本地端口转发（会话）、WebSocket Bridge 连接，再确认 micro-ROS Agent；首页用步骤高亮与四段状态灯（SSH / Bridge / Agent / HardwareStatus）标出卡点。Enter 可连接，Esc /「关闭」可收起错误；失败支持「重试」（全量重连）与「复制错误」。
- 首页展示上次连接一行摘要（耗时或失败步骤/原因）。成功 SSH 的主机记入最近主机一键回填。
- `ROS_DOMAIN_ID` 与默认或上次成功值不一致时，状态条给出轻量提示。
- **默认**连接成功进入 Status；顶部工具条提供「断开并重连…」、Bridge 版本徽章（不匹配点开既有升级提示）、Fault 芯片（跳转 Status Hardware 高亮）。设置可关闭「连接成功后打开 Status」。
- Bridge 订阅默认 JointState Topic 后，收到首帧即视为 ROS 就绪（冒烟）；此前 Monitor / Motor 导航禁用。HardwareStatus 首帧点亮对应状态灯。
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
- Status 卡片在 SSH 可用时可「重新拉起」（`systemctl restart` only，不刷写固件）；失败时带回 status/journal 尾部。

## 3. ROS Topic 浏览器

- 从 ROS graph 获取 Topic 名称和类型。
- 点击 Topic 后创建只读订阅，并以 JSON 查看最新消息。
- 显示累计消息数和平均接收频率。
- Topics 列表头部提供即时搜索框，可按 Topic 名称或消息类型进行大小写不敏感过滤，并显示匹配数/总数；过滤仅影响本地显示，不改变订阅状态。
- Topics 列表默认每 30 秒重新请求 ROS graph，也可通过标题栏刷新按钮立即刷新；自动刷新周期可在应用设置中配置为 5–300 秒。刷新失败时保留现有列表并显示原因。
- 页面导航只保留在左侧 Navigation，**Status** 为第一项，其后为 Topics、Motion、Monitor、数据采集、Motor、Calibration 和重力辨识。Topics 集中 Graph / Inspector、Topic 列表与 Controller 只读浏览；Motion 提供 Robot View / 姿态库 / 动作组 三个局部 Tab、可折叠 Controllers 管理侧栏和共享运动日志。数值曲线在 Monitor 导航页。顶部工具栏不再重复品牌或导航。
- **Status** 页复用现有连接态并增强详情：SSH/隧道、Bridge WS + hello、micro-ROS Agent（`check_micro_ros_agent` / `restart_micro_ros_agent`）、HardwareStatus（成功时「无故障 · mode」、失败时 fault 描述）、JointState 冒烟与 Hz、`check_ros_controllers`、ROS_DOMAIN_ID；USB CDC 经 SSH `probe_jetson_usb`（MCU `0483:5740`、串口、RealSense `8086:*`）仅「刷新检测」；Teleop / Trajectory / RealSense 卡片经 `probe_arm_mode` / `start_arm_mode` 一键拉起（SSH BatchMode，优先从当前 ROS setup 目录定位工作区，可用 `LEADER_FOLLOWER_WS` 覆盖，并兼容旧 `leader_follower` 目录；启动前读取新鲜 HardwareStatus，拒绝未恢复的锁存故障；停止旧 Teleop / Trajectory 前调用现有硬件 safe_stop（按当前增益执行 RETURN → DISABLE），等待 STM32 DISABLE 确认后仅通知启动脚本清理，不发送孤立 HOLD；安全停止被拒绝或确认超时时保留命令进程并报错；SSH 侧互斥保护并等待脚本完整自检与非零命令确认后才报告启动成功，超时保留 PID 供「停止」处理）。回零停不下来时可选择「解除输出并停止」，确认现场支撑后由控制器 `~/disable` 服务持续发送零输出 DISABLE，收到 STM32 回执后才停进程（需要支持该服务的 ROS 控制插件）；服务缺失或回执失败时不会改用外部发布者或强杀。一键 Teleop 执行 `scripts/start_arm_teleop.sh --position-controller=teleop --gravity=true --gripper=true --clean=false --start-leader=true`。一键 Trajectory 执行 `scripts/start_arm_teleop.sh --position-controller=trajectory --gravity=true --clean=false`，并按新鲜硬件使能掩码的 bit0x40 选择 `--gripper=true/false`，默认同时启用独立的 `gravity_compensation_controller`；仍等待启动脚本完成控制器状态自检后才报告成功。**VLA** 卡片经 `switch_ros_controllers` 启停 `vla_position_controller`（互斥 `arm_teleop_controller` / `arm_trajectory_controller`，保持 `gravity_compensation_controller`）；启动时与 Teleop/Trajectory 一样，先安全回零、确认 DISABLE、清理并核验旧模式，再以 Trajectory+gravity 初始化新控制环境，在同一原生互斥锁内切到 VLA；不复用旧命令状态，初始化/清理失败则中止；成功后校验 controller active（及可用时的 TRACK）；`fault_code=11` 禁用启动类按钮。可选采样 `/vla/joint_chunk`（`VlaJointChunk`）。Monitor 提供 `+VLA` 模板（`positions[0..5]`）。完整用法见 [VLA 使用指南](./vla)。无一键升级全部或自动刷写 STM32。
- Status 分为「连接 / 硬件健康 / 控制模式」三个 Tab；硬件健康包含 USB、Hardware、时钟同步和 RealSense，控制模式包含 ros2_control、ROS 就绪及当前运行模式卡片（未启用模式时仍显示前两张）；默认打开连接。Tab 按卡片状态聚合，异常优先于注意、未知、正常、空闲，隐藏分区仍持续更新汇总；支持左右方向键、Home/End。Fault 芯片会自动打开硬件 Tab 并高亮 Hardware，HOLD / 故障提示在所有 Tab 保留。
- 控制模式 Tab 保留互斥模式条与停止/解除输出确认，并提供实时日志：默认按当前模式选 Teleop、Trajectory 或 ROS 控制器/VLA，也可选择 RealSense。通过 Tauri `read_control_log` 走只读 SSH，每轮完成后间隔 1 秒刷新，仅在控制 Tab 和窗口可见、SSH 可用时工作；搜索不区分大小写并移除终端控制字符。关闭「跟随最新」或向上滚动后保留阅读位置，刷新不覆盖搜索内容。

Robot View 左臂腕部点云默认使用 `/cameras/left_arm/wrist/` 下的彩色图像、对齐深度和 CameraInfo；一键 RealSense 启动 ROS 栈的 `left_wrist_camera.launch.py`，启用深度对齐和时间同步，并把 `camera_link` 接到相机的 `left_arm/wrist_link`。Bridge 对三个流分别选择兼容的可靠性，均以 `VOLATILE` 订阅，兼容 RealSense 图像与 CameraInfo 不同的 durability；点云帧最多等待 150 毫秒获取采集时刻 TF。若 500 毫秒内有成功帧，短暂 TF 失败不会中断上一帧；持续失败会隐藏过期点云并显示错误，避免与实时 URDF 姿态错位。点云开关、着色、点大小和近远距离控件可交互；尚未收到完整 RGBD 帧时显示等待提示。修改过的自定义 Topic 配置不会被默认迁移覆盖。启动文件需先安装到 Jetson 的 `rebotarm_gazebo` 包。
- 日志窗口展示末尾 128 KiB / 2000 行；「下载完整日志」通过保存对话框保存未经过搜索过滤的 `.log` 文件（最大 32 MiB，超过时明确拒绝）。来源仅限 `$HOME/.cache/robot-console/arm-{teleop,trajectory,realsense}.log` 和 `$HOME/.ros/log/ros2_control_node_*.log` 中最新文件；VLA 日志随宿主控制器进程记录。缺失日志显示等待，读取/下载失败显示原因；SSH 操作有 10 秒远端 / 15 秒本机超时，切换来源、隐藏或断开后忽略旧响应。此功能不启停 ROS 或机械臂。
- 已连接工具条与 Navigation 标题共享顶部行高度，两侧底部分隔线始终对齐；窄窗口时状态灯换到下一行并同步撑高标题区。导航列表与主页面内容在标题区下方独立滚动，不与连接控件重叠。
- 已连接顶部工具条提供「断开并重连…」、连接配置、设置、压缩状态灯（含 ROS 就绪 / Bridge 版本徽章 / Fault 芯片 / Domain 提示）、连接名、隧道端口、Agent 与断开；全局工具栏保留全部刷新、实时显示暂停/恢复、rosbag 录制、诊断快照与重置布局。
- Topics 页的 Topics、ROS Control、Inspector 三个区域可独立展开/收起；左右侧栏也可整列最小化并恢复，状态保存在本机。Topics 与 ROS Control 会自动使用另一面板释放出的高度。
- Topics/ROS Control 之间可上下拖动调整高度；左右侧栏边界可横向拖动调整宽度，面板尺寸会持久化到本机。分隔条支持键盘方向键微调。Topic 名称与类型悬停显示全称。
- Topics 下方显示 `/controller_manager` 当前加载的 ROS Control Controller、类型及 active/inactive 等状态。桌面每秒经现有 WebSocket 读取 Bridge 共享缓存，不再为列表刷新启动 SSH/ROS CLI；Topics 自动刷新间隔单独设置。
- ROS Control 标题栏提供手动刷新按钮，与展开/收起按钮并列；手动与自动刷新具有并发保护。自动轮询静默更新，不触发“全部刷新”或“刷新 Controllers”的忙碌显示；手动刷新和操作核验仍显示进行中状态。健康结果默认仅显示稳定的“最新”摘要，快照年龄与后台查询进度可展开“查询详情”查看，故障、过期及真实 Controller 状态变化立即展示。手动刷新及控制器操作前后等待请求进入后新发起的 ROS 查询，切换期间发起的查询不能充当切换后核验。
- Topics 的 Controller 卡片提供「查看 Graph」聚焦关联节点、Topic 和连线，以及「管理」跳转 Motion；本页只读。Motion 中确认 Activate / Deactivate 后，通过 SSH 调用 Humble `ros2 control switch_controllers --strict`，完成后共享刷新列表并展示成功或错误信息。
- Controller 名称和操作类型在 Tauri/Rust 后端校验，拒绝包含 shell 特殊字符的输入。列表与运动健康检查共用单个常驻 ROS 客户端，沿用 2 秒请求上限、3.1 秒状态有效期和失败退避，保留既有 active、接口认领和故障门禁。新鲜成功结果不显示“重试等待”，仅失效状态显示退避等待时间。缺少 MoveIt 支持时仍可查询列表；缺少 Controller Manager 消息支持或旧 Bridge 时明确提示升级，不回退到冷启动 CLI 查询。
- 兼容 Jetson 当前 Humble `ros2controlcli` 的超时参数类型缺陷：不显式传入 `--switch-timeout`，使用其内部浮点默认值，并由外层进程提供 10 秒超时保护。
- Controller 列表区分首次等待、查询中、服务不可用、查询超时、数据过期及 Bridge 不支持。失败后保留同会话最后成功列表并标明年龄/错误，只供查看；不再把一次查询失败直接显示成控制器离线。成功空列表明确显示暂无 Controller。连接代变化清除旧列表，过期数据禁止 Controller 切换及当前模式确认。
- Bridge 可订阅 Jetson 当前 ROS 环境中已安装类型支持的消息类型。已知的基础消息保留原有字段格式；其余类型通过 ROS 2 运行时字段描述递归转换为 JSON，包括 `control_msgs/msg/JointTrajectoryControllerState` 的嵌套字段和数组。类型支持缺失或请求类型与已发现的 Topic 不符时显示具体错误。

### Motion 工作区

- Motion 可在 ROS 未就绪时进入，查看已保存位置及就绪原因；执行继续要求连接、MoveIt、active 控制器、新鲜反馈、时钟和既有安全确认。
- Topics 的 Controller 卡片提供「查看 Graph」和「管理」导航；实际 Activate / Deactivate 只在 Motion 侧栏，确认前重新核对状态；运行中的运动或其他控制任务会阻止切换。Status 保留整栈启动、模式切换、安全退出与解除输出。
- Motion 顶部展示机械臂/夹爪控制器、MoveIt、关节反馈和时钟状态；Robot View、姿态库与动作组共用底部规划执行日志。左侧 Controllers 默认收起，可通过工作栏“面板”展开；已有展开偏好继续恢复。
- Controllers 宽度、日志高度和点位列表/编辑区可拖动分隔条调整。方向键每次调整 10px，Shift + 方向键每次 40px，Home/End 到边界，双击分隔条恢复该项默认值。窄姿态库页改为列表/编辑上下分区。
- Robot View 画布铺满内容区；「运动控制」「时钟同步 / RGBD」「TCP / 关节操作」支持画布内浮窗。紧凑工作台的 TCP / 关节操作默认停靠右侧，可切换浮窗，也可直接拖动标题脱离停靠（单击标题不会切换）；未保存偏好时运动状态和 RGBD 默认折叠，异常仍在状态摘要或面板标题提示。拖动标题移动，右下角手柄调整大小；标题和缩放手柄也支持方向键每次 10px、Shift 每次 40px。每个浮窗可折叠，画布顶部按钮可重新展开并置于最前；「重置浮窗」恢复默认位置、大小和展开状态。折叠保留当前编辑内容，不改变点云订阅或执行状态。面板内滚动/点击不操作相机，拖动浮窗不下发运动。
- 分隔尺寸独立保存于 `robot-console-motion-layout`；浮窗位置、大小和折叠状态保存于 `robot-console-viewer-floating-panels-v1`，重启恢复。缩小窗口限制浮窗及其标题在画布内，面板内容独立滚动；仅显示尺寸约束不覆盖宽屏偏好。在 Motion 点击全局“重置布局”恢复分隔尺寸和所有浮窗并恢复图标导航、收起 Controllers 和输出区，保留当前 Tab 与编辑内容。
- 导航页、Motion Tab 与 Controllers 展开状态独立记忆。Motion 默认 Robot View；旧 `dashboard` 导航标识继续表示 Topics。连接后默认跳 Status 的既有独立设置继续适用。
- RGBD 仅在 Motion → Robot View、窗口可见、实时显示和 RGBD 配置开启时订阅；姿态库 Tab、Topics 和其他页释放当前客户端兴趣并清空点云。已加载的 Robot View 场景仍保留，隐藏时停止绘制并取消未结束的拖拽。

### Motion 紧凑工作台

- Motion 将连接状态、全局工具和三个视图 Tab 合并为单条工作栏。主机按钮展示就绪或当前异常，展开可查看 SSH/Bridge/Agent/硬件/时钟及连接操作；Controllers 位于“面板”，刷新、实时显示、录制、诊断和布局重置位于“更多工具”。显示暂停和录制中保留常驻标记。后台轮询与原有安全核验保持运行，切换/断线清除会话数据的行为不变。
- Motion 默认图标导航，其他页面保留自己的展开偏好。“专注模式”临时隐藏导航、资源、属性、Controllers、Robot View 操作窗和展开日志；退出恢复原布局，不清除未保存编辑或预览。主动打开属性/输出/Controllers 时退出专注。正在运行的任务、取消/停止、执行前检查和故障摘要持续可见。
- 动作组左侧使用“动作组 / 姿态库”资源 Tab 和名称搜索；属性默认收起，单击块选择并本地预览，双击或菜单“属性”展开。属性可固定，下次恢复；未固定时仍保留当前会话展开状态。预览与时间轴支持分屏、仅预览、仅时间轴，资源区也可单独收起。窄宽度的属性区使用可关闭抽屉，不额外增加一行编辑区。
- 动作组、源姿态、Pose/Action 块、轨道和时间轴空白支持右键菜单；工作区与卡片提供 `⋯` 替代入口。菜单支持 Shift+F10、方向键、Enter、Escape 和点击外部关闭。工具弹层也支持 Escape 收起并返回入口，不要求先点击或聚焦弹层内容；已由上层对话框处理的按键不再关闭其后的工具弹层。文本输入保留系统右键操作。Pose 可替换快照、前后插入、复制、添加拍照和删除；Action 可修改属性/依赖、复制和删除。删除 Pose 同步移除依赖 Action/同步点，撤销可恢复。轨道仅允许删除未使用轨道，且至少保留一个机械臂轨道。
- 持久化动作组/姿态删除继续确认，切换未保存动作组继续提供保存/放弃/返回。编排块修改使用既有撤销记录；运行组锁定编辑，菜单和快捷键不能绕过。实际运动与 Controller 切换不由右键快捷触发，继续使用明确入口及原安全确认。
- 工作台快捷键：⌘/Ctrl+S 保存动作组，⌘/Ctrl+Z 与 Shift+⌘/Ctrl+Z 撤销/重做，Space 播放/暂停本地预览；选中且聚焦的编排块可用 Delete/Backspace 删除并撤销。输入框、对话框、菜单、隐藏页面或拖动中不截获这些快捷键；不映射真实运动或停止指令。保存反馈位于组名旁，失败仍明确显示原因。
- Robot View 画布右键或 `⋯` 提供适应模型、正/侧/俯视图、网格/坐标轴开关和打开 TCP 操作区。这些操作不修改目标关节或下发运动，青色球与 XYZ/RPY 微调、确认执行、保存实测姿态保持可用。
- 紧凑面板偏好使用 `robot-console-workspace-*` 本地键，分隔尺寸和浮窗位置沿用原键。专注模式不覆写这些偏好。输出区默认折叠，展开偏好继续记忆；报告可随时通过标签或“查看执行报告”打开。正常保存不再显示占据整行的提示。

## 4. Topic Graph、Inspector 与 Monitor

- Motion 集中 Robot View、「姿态库」和「动作组」Tab；Topics 中心固定展示 Topic Graph，数值图表使用 Monitor 导航页。Topic Graph 展示 ROS Node、Topic，以及 Publisher/Subscriber 的有向连接关系，视觉语义与 `rqt_graph` 一致。「姿态库」保存当前连接（SSH 主机、用户、端口）下的六轴及可选夹爪点位，HOME 固定为 `builtin:home`，界面和保存文件都不能删除、改名或覆盖它；数值尚未从 Jetson SRDF 同步时显示「待同步」。每个点位左侧按 URDF 关节链和保存关节值显示简化 3D 姿态：立体连杆、关节、基座地面网格及末端红 X / 绿 Y / 蓝 Z 方向轴，保存夹爪目标时展示手指开度。HOME、编辑和动作组预览共用这一展示；使用固定斜视角并自动取景，不加载 mesh 或为每张卡片占用 WebGL 上下文。缺失或无效姿态显示「无姿态」，预览不下发运动；没有实机 `robot_description` 时用内置运动学模型。「保存当前姿态」位于 Robot View → TCP 操作区最下方，点击打开命名、可选夹爪及备注窗口；窗口固定点击时的实测快照，后续反馈和未执行的 TCP 预览不会改写它。读取 1 秒内完整的 joint1–joint6，优先配置的 JointState，否则用 `/joint_states`。重力补偿下手把手臂拖到目标位置后可以保存，只记录关节角，不下发运动。未连接时连接页的「管理姿态库」打开同一份数据。新姿态从 Robot View 保存；姿态库只保留执行、编辑和删除，不再提供“手动新增”或“启动 MoveIt”。
- 点位执行使用 Jetson MoveIt2：连接后在 Status 启动 Trajectory，原生流程会在轨迹控制器和 gravity 自检通过后启动 `real_move_group.launch.py`。随后勾选会话内安全确认，双击 Motion 姿态库的 3D 缩略图，由 MoveIt 规划移动到该姿态（包含 HOME）；聚焦缩略图按钮后 Enter / 空格也可执行。单击仅选中，不下发运动，不打开独立预览区；卡片名称、空白区域及编辑菜单不触发运动。列表采用类似 Finder 的缩略图卡片，按列表实际可用宽度自适应多列；打开 Controllers 或编辑区时自动重新排列。每张卡片固定以 joint1–joint3、joint4–joint6 两行显示关节值；极窄卡片内标签和值上下排列，避免相互遮挡。编辑区仅通过右键或 `⋯` 的“编辑姿态”展开。忙碌、未就绪、未解锁、该姿态正在编辑或夹爪能力不足时禁用执行。保存、编辑和删除不会触发运动。HOME 来自当前 `/move_group` 的 SRDF `arm/home`，未同步时不可执行，不以全零替代。
- MoveIt `/move_action` 负责碰撞规划、时间参数化及通过配置好的 `arm_trajectory_controller/follow_joint_trajectory` 执行完整轨迹。支持 `arm` 六关节及可选 `gripper` / `arm_with_gripper`，通过独立夹爪 JTC 协调执行；执行请求不自动切换控制器。速度与加速度缩放为 1.0（不缩放）；服务端需禁用自动控制器管理、配置起点容差 ≤0.02 rad、速度 ≤2 rad/s 与加速度 ≤2 rad/s²（真实入口采用 2/2、缩放 1/1、起点 0.01）。未知/缺少 MoveIt 编译支持时禁用执行并提示原因。
- Bridge 在规划前及执行期间校验控制器 active、三类反馈 <1 秒、TRACK/故障/使能掩码、反馈一致性、完整有限关节值和模型限位。跨连接只允许一个点位运动，`command_id` 去重；规划/执行超过 180 秒、故障、反馈丢失、配置变化、连接断开或会话心跳超过 5 秒会请求取消。手动 MIT（DISABLE 除外）、旧拖拽轨迹及重力辨识不能覆盖正在运行的点位运动。
- 启动点位前核对 active JTC 实际认领六关节 `position+velocity` 接口，并要求实测关节速度 ≤0.05 rad/s。已移除独立的启动连续性检查：不再校验 JTC desired/reference 的位置偏差、参考速度或字段完整性，也不等待参考连续稳定 200 ms。MoveIt 仍以新鲜实测关节状态作为规划起点，保留自身起点容差与碰撞检查；JTC actual 与 STM32 实测位置仍须相差 ≤0.02 rad。此变更不改变低速跟踪或重力补偿。旧 position-only JTC 仍不可执行点位。
- 界面显示校验、规划、执行、到位检查和取消阶段；只有 MoveIt Action 成功且新鲜六关节反馈的速度 ≤0.03 rad/s 持续 200 ms 才报告执行完成；最终关节位置误差不再作为完成门槛，仍显示实际与目标差值。TCP 独立位姿校验保持有效。取消 ACK 不代表停止；确认新鲜反馈停稳后才显示取消完成，5 秒未确认则显示“停止未确认”并保持锁定。断线不会自动重发运动。
- 碰撞检查覆盖 URDF 自碰撞与 MoveIt Planning Scene 中的已知障碍物。Robot View 显示的 RGBD 点云目前不自动写入 Planning Scene，不能据此声称已检查现场所有物体。
- Robot View 左上角有「运动控制」面板。还没有执行结果时显示「无运动」。误差由下发关节或 TCP 目标与停稳反馈计算：关节为弧度差，TCP 位置为毫米、姿态为角度。切回 Robot View 后该面板持续展示点位运动状态；任务进行中，全局状态条在其他页仍显示阶段，可返回 Motion 或取消本会话运动；其他会话只显示忙碌提示，点位运动期间锁定 TCP 拖拽；TCP 松手保留预览，显式确认后也由同一 MoveIt 运动状态机执行并显示阶段。
- Topic Graph 在打开时立即加载，默认每 30 秒自动刷新，也可点击“刷新 Graph”手动刷新；图变化不影响现有 Topic 数据订阅。
- Graph 使用确定性的力导向布局：ROS Node 为圆角矩形、Topic 为椭圆，使用与界面一致的蓝青/青绿色，连线保留发布/订阅方向；图形大小反映连接数。节点之间有斥力、连接有引力，并进行碰撞消除；初始布局以可用尺寸为参考，但节点坐标不受初始布局矩形限制。默认隐藏 Bridge 节点及其私有 Topic，可用“显示 Bridge”开关恢复；共享机器人数据 Topic 保留。
- 无限画布初始以 100% 缩放居中节点，支持滚轮/按钮缩放、空白处拖拽平移；可将节点拖到初始布局之外，刷新后仍保留手动位置（节点仍存在时）。Fit 根据所有节点的实际位置缩放取景，Reset 以 100% 缩放将现有节点居中；选中节点后仍可自由平移，松手不会重新居中。节点标签完整显示 Node 与 Topic 的原始名称，保留 `/`，不截断或附加省略号；每行最多 10 个 Unicode 字符，图形随行数增大以容纳全部文字。完整名称也可从悬停提示和辅助标签读取。连接线上用粒子动画示意数据流向与快慢（当前为占位流速：publish 快于 subscribe，尚未接真实 Hz）。
- 点击任意图形会高亮其一跳关联节点和连线、弱化其他拓扑；点击左侧 Topic 列表也会切到 Graph、滚动到对应 Topic 并聚焦。点击 Topic 图形创建只读订阅，点击 Node 图形显示其详情。
- 右侧 **Inspector** 以“数据 / 详情”Tab 区分：Topic 数据显示完整名称和原始 JSON，Image 显示 Canvas 预览与紧凑元数据；Topic 详情按需从 Bridge 获取发布者、订阅者、GID 和 QoS。选中 Node 时自动显示其发布、订阅、服务和客户端列表。订阅失败单独提示，不会中断 Graph 刷新。
- 在 JSON 中右键有限数值叶子、数值数组字段或数组元素，先选择 Monitor **仪表盘（Dashboard）**，再选择已有 **Panel** 或「新建 Panel」；数组字段展开为 `field[0..n]` 多条序列，加入同一个 Panel。已有 Panel 会保留原序列并去重。菜单支持方向键、Esc 和返回上一级。
- **Monitor** 导航页：Grafana 式 **Dashboard → Panel → Chart**。多仪表盘（创建/重命名/删除，配置写入 localStorage `robot-console-monitor` v2 并在重启后恢复）；默认「Motor Torque」仪表盘含 **7 个可拖拽/缩放 Panel**（`effort[0..6]`，`react-grid-layout` 12 列，共享 30 秒时间窗与共享准星，Y 轴各自缩放）。每个 Panel 可选时序图（折线/点/时间柱）、柱状图（按字段最新值，横向/竖向）、环形图（正值占比）和 Gauge（最新值、可设范围与阈值）；无有效值时显示等待提示。紧凑 Panel 的标题、类型选择和移除按钮位于同一拖拽栏；独立 DataGraph 仍保留右侧图例。支持暂停跟随（冻结采样+时间窗）、双击最大化、重置布局、锁定布局与紧凑排列（锁定/紧凑偏好持久化；最大化仅会话内）。旧版单序列 Panel 和 `panels[].series[]` 标签页配置会在加载时迁移，图表设置与命名布局预设可持久化。全局「暂停显示」与 Monitor「暂停跟随」同源。
- Monitor Bag 回放：经 Tauri SSH 在 Jetson 执行 `ros2 bag play <path> --clock`，曲线仍走 Bridge 实时订阅；本机解析 bag / 下载 / 索引未实现。路径校验与录制相同（拒绝 `~`、`.`/`..`、shell 元字符等）。
- `sensor_msgs/msg/Image` Topic（包括 `/camera/color/image_raw`）在数据 Tab 使用 Canvas 实时预览，支持 rgb8、bgr8、rgba8、bgra8、mono8、mono16 及对应 OpenCV 8UC/16UC1 编码、行步长和大小端转换。
- 图像只投递给明确订阅的 WebSocket 连接；取消订阅或断线后释放兴趣，最后一个兴趣消失后释放对应 ROS 图像订阅。仅在 Topics 的 Inspector 数据 Tab 可见且实时显示开启时订阅选中图像；切主导航、折叠 Inspector/右侧栏、切详情 Tab、暂停实时或隐藏窗口会取消图像订阅，返回自动恢复。已取消兴趣的残留帧不会重新填充预览。
- Image 数据由 Bridge 使用 WebSocket 二进制帧全速传输，帧头保留 JSON 元数据、像素保持原始字节，避免 Base64 膨胀和大 JSON 解析；Canvas 使用浏览器动画帧合并绘制，不丢弃 Bridge 消息且不影响 Topic 频率统计。元数据展示尺寸、编码、step、时间戳与原始字节数但不展开二进制内容。
- Graph 可以展示 ROS graph 中的全部 Topic；实时内容解析要求对应消息类型支持已安装在运行中的 Bridge ROS 环境。64 位整数超过 JavaScript 安全整数范围时以十进制字符串传输，非有限浮点数转为 `null`。

## 数据采集（LeRobot v3）

- Navigation 的「数据采集」页对接已安装的 `rebotarm_vla`；Mac 不需要 ROS 或 LeRobot。先在 Status 启动包含夹爪的 Teleop 和 RGB 相机，再配置数据集 ID、Jetson 保存目录、任务、FPS（默认 20）、腕部及可选固定相机 Topic。
- 数据源默认 `/stm32/joint_states`（MCU 经 Agent 的 stamp；host 时钟的 `/joint_states` 不适合 stamp 门禁，表单仍可改）、`/arm_teleop_controller/commands`、`/gripper_teleop_controller/commands`。旧偏好中的 `/joint_states` 会迁移到 `/stm32/joint_states`。关节状态须包含 `joint1..joint6` 与米制 `gripper_finger_left_joint`（0.05 m 打开、0 m 关闭）。采集器输出七维 state/action，夹爪按 0 打开、1 关闭归一化。
- 「启动采集器」通过 Tauri `data_collection_action`，source 连接 Profile 的 ROS overlay，调用 Jetson 上的 Python（默认 `venvs/lerobot/bin/python`）执行 `python -m rebotarm_vla.lerobot_recorder --no-keyboard`。必须预先安装 `rebotarm_vla` 与兼容的 LeRobot v3；启动会实际导入 LeRobotDataset 检查后端依赖并报告错误，不安装软件。若虚拟环境包含 NVIDIA `cu12/lib` 或 `cudss/lib`，仅为预检和采集器子进程补充这些现有库路径，保留 ROS 的库路径。
- 通过固定 `/lerobot_recorder/start_episode`、`save_episode`、`discard_episode`、`status` Trigger 服务控制 Episode；每 5 秒查询采集状态、帧数、已保存 Episode、FPS、任务和日志。仅开始 Episode 需要本会话收到 JointState；状态、保存、丢弃和结束在缺少反馈时仍可用。无有效帧时提示检查 Topic、同步与日志。
- **开始 Episode / 启动采集器前的双重门禁**：① Bridge 侧：Episode 卡片展示 `/stm32/status`（mode / fault_code / last_command_sequence）与 **配置的 stateTopic**（默认 `/stm32/joint_states`）时间戳健康度；未收到 status、`fault_code != 0`、非 TRACK、stamp 全 0 或采样过期时禁用「开始 Episode」。采集中离开 TRACK / 非零故障时危险横幅建议丢弃（不自动丢弃）。② Jetson 侧硬门禁：启动采集器与开始 Episode 时 SSH 执行工作区 `scripts/check_collection_ready.sh`（`--ros-domain-id` / `--workspace` / `--timeout=8`，**不用** `--warn-only`）；非零退出时阻断并把脚本输出展示在错误区。工作区解析顺序：`LEADER_FOLLOWER_WS` → `rosSetupScript` 去掉 `install/setup.bash` → `$HOME/Project/rebotarm-ros2-stack`。清单与脚本说明见 stack [data-collection.md](https://github.com/phamstered/rebotarm-ros2-stack/blob/main/docs/data-collection.md)（PR #22）。将 `/stm32/status` 写入 LeRobot 数据集仍属 recorder / 外部包后续工作。
- 丢弃当前 Episode 需要确认。存在采集中或未保存帧时拒绝结束；保存或丢弃后，才能「结束并完成数据集」。结束只向本应用启动且 PID/启动时间身份匹配的采集器发 SIGINT，等待正常 finalize；不会强杀编码进程。外部启动的采集器可操作 Episode，结束须回原终端。已保存过 Episode 时，以日志中的 `Dataset finalized` 确认正常收尾。
- 数据集写入 Jetson，本页不上传。新建时拒绝已存在目录；续录需存在 `meta/info.json`，并提前检查 FPS、相机集合、七维 state/action 布局；图像分辨率及单位也须与原数据集一致。计数来自采集器服务，续录数据集在首个有效帧时打开，此前已保存计数可能为 0。
- 表单偏好保存在本机；首次、周期性及手动状态查询不会锁定配置输入，查询成功或失败均保留输入内容和焦点。采集器运行中或状态变更操作执行期间，配置继续锁定。切换页面或断开连接后远端采集器继续运行，回到同一主机/ROS Domain 可恢复查询。远端进程记录、锁与日志按 ROS_DOMAIN_ID 隔离在 `~/.cache/robot-console/data-collection/domain-N/`。并发操作受保护；连接变化或页面卸载后的旧响应不会更新新页面。路径、Topic、数据集 ID 与参数在原生后端校验，任务文本以独立参数传递；本页不启动遥操作、不切换 Controller、不发布电机命令。
- 隔离 ROS 冒烟测试：`python3 scripts/smoke-data-collection.py --host jetson --domain 197`，按需加 `--ros-setup` / `--ssh-port`，domain 必须选择现场未使用的隔离值。脚本在远端临时目录启动模拟采集器，只验证启动、Episode 服务、计数和退出，清理后不改动已安装 package 或真实数据集。

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
- 大型 URDF 网格采用顺序加载，避免多个大型 WebSocket 响应同时排队；单个资源使用 30 秒超时，并在失败提示中显示具体 `package://` URI。
- 首次访问后保留已加载的 Three.js 场景、相机和 OrbitControls；切换 Topic Graph 或主导航后返回无需重取资源或重建场景。隐藏时停止帧循环并取消未结束的 TCP 拖拽；未完成的加载则取消，返回时重试。资源和纹理全部完成后才显示模型，并显示获取/解析进度。
- 会话内资源使用 128 MiB LRU 字节缓存，同时请求同 URI 会合并。失败不缓存，超出预算的单文件可使用但不留存；断开/重连会清空缓存，URDF 变化释放旧场景，Blob URL、geometry、material 和 texture 随场景释放。同 URI 文件内容改变后需重连获取新版。
- 资源优先走 `RCR1` 原始二进制帧，兼容旧 Bridge Base64 响应；单文件上限 64 MiB。切页/断线会取消本地等待及后续资源请求，迟到结果不会挂到新场景；已发送的远端资源读取不会被中止。
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

## 9. 重力辨识（Bridge/UI；orchestrator pending）

**不标完整「已实现」。** Desk 已提供「重力辨识」页与 Bridge op（`gravity_id_*` → `/StartGravityID`）。stack [#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24) 提供 FULL_ARM 编排（12 姿态、TRACK 前馈、YAML+hot-reload）；PAYLOAD 拒绝。Jetson 实机 E2E 前不写入「已实现」矩阵。Bring-up：`state_only` + `gravity_identification.launch.py`。见 [重力辨识](./gravity-identification)。

## 10. Joint4 重力标定

- 左侧 Calibration 页面订阅 `/joint4_calibration_controller/status`，展示关节位置、速度、模型/修正/所需力矩、参考位置、稳定时间与保护状态。
- 标定流程通过受限的 `std_srvs/srv/Trigger` 服务执行 Begin、Capture、Release、Fit 和 Reset，界面不直接写入 URDF 或控制参数。
- Capture 仅在 Controller active、状态新鲜、姿态保持稳定且确认手部支撑已撤掉后开放。
- `safety_fault` 会锁定采样和拟合；托住 joint4 后可执行 Release 清除新版 Controller 的故障锁存。对旧版 Controller，姿态已释放且速度不超过 0.05 rad/s 时允许重新 Begin，以当前安全位置重建参考，避免界面与 Controller 互相锁死。
- 标定采样和拟合结果可保存为本机 JSON/CSV 审计报告。

## 11. TCP 拖拽轨迹下发

### Robot View 关节联合调整

- 在 Robot View 选择「关节调整」，可分别输入 joint1–joint6 的目标角度（度），也可选择或点击模型关节后用滑块调整。所有已编辑轴同时预览，切换所选关节保留其他目标；未编辑轴继续显示实时反馈。夹爪（joint7，`gripper_finger_left_joint`）为独立直线自由度，以单指行程 mm 调整；fixed 与 mimic 关节不提供独立操作。
- 调整仅预览，反馈不会覆盖已编辑目标。「恢复实时」、Esc、切换操作方式、隐藏视图或模型/连接变化会清除预览；显示实际角度、目标和所选关节 URDF 限位。连续关节不强制回绕。
- 运动时长默认 5 秒，接受可用 ROS 时间表示的有限正数，不再限制为 0.1–120 秒，也不以低于推荐时长为由拒绝。MoveIt 规划返回的原始时长在界面显示，仅供参考；轨迹可伸长或压缩，速度除以时间倍率、加速度除以倍率平方。Bridge 使用当前受控关节限速/限加速度，对整段三次/五次插值样条做保守上界校验，超限或无法验证时拒绝执行；夹爪还校验整段插值不越过标定行程。运动时长不含规划和到位核验耗时，长运动总超时随指定时长增加，5 秒会话心跳要求不变。
- 勾选工作区安全确认并点击「确认执行」后，一次提交所有已编辑关节及运动时长。Bridge 从新鲜实测状态补齐其余轴目标，并添加 ±0.001 rad 路径保持约束；全部六轴已编辑时不添加保持约束。无法在约束内避碰则规划失败；约束不构成硬件零误差保持保证。
- 定时执行使用 MoveIt `/move_action` 的 plan-only 结果，校验路径、起终点和时序后，通过 `/execute_trajectory` 一次执行完整轨迹。规划与执行共享运动锁、心跳和取消；执行前再次核对新鲜反馈、实测起点与 MoveIt 起点容差，已取消或断线的规划不进入执行。Action 成功并由新鲜反馈确认停稳后报告执行完成，最终关节位置误差仅作诊断。
- 保留 active JTC、六关节 position+velocity 接口、TRACK/故障、反馈新鲜度/一致性和实测停稳等安全条件；不恢复已删除的 JTC 参考连续性检查。需要 Bridge 广告 `joint_targets_supported` 和 `motion_duration_supported`，缺失时禁用确认执行；`/execute_trajectory` 未就绪时显示具体原因。其他 URDF 旋转关节可预览；真机执行允许 arm 六轴及经过能力核验的独立夹爪。

### TCP 拖拽

- Robot View 从 URDF 解析关节链并定位 TCP（夹爪）link：连接配置里的 `tcpLink` 优先；留空时优先选择 tool0/tcp/ee_link 等工具坐标系，其次选择 gripper/flange 等稳定 link，可以是带手指子 link 的夹爪基座，不因手指层级更深就选到 finger/jaw。无命名工具 link 时回退到最深叶子 link。视图显示实际使用的 link；rebotarm 默认选择 `gripper_link`。
- 仅当 `/controller_manager` 存在 active 的轨迹控制器时开放拖拽；识别规则为类型 `joint_trajectory_controller/JointTrajectoryController` 优先、名称含 traj 次之。ROS Control 列表会用“轨迹”标记对应 Controller，Robot View 右上角显示其名称和 `/…/joint_trajectory` Topic。
- TCP 目标保留青色中心球：在固定的相机平面内自由拖动，用于快速定位，保持目标姿态且抓取偏移不跳变。红 X、绿 Y、蓝 Z 平移箭头、旋转圆环和 XYZ/RPY 数值用于微调，均保持屏幕尺寸；可选基座轴或随工具旋转的轴，中心球始终按相机平面移动。平移保持目标姿态，旋转保持目标位置；抓取手柄时暂停轨道相机，其他位置仍可移动相机。Esc、丢失指针捕获、隐藏视图、模型/TCP/连接变化均取消预览并恢复实测姿态。
- 拖拽过程按帧求位置逆解：有限差分雅可比 + 自适应阻尼最小二乘，关节限位钳制，单次下降卡住时做确定性随机重启。同时求解位置与姿态，保留关节限位、自适应阻尼和确定性重启；只有位置误差 ≤5 mm 且姿态角误差 ≤0.02 rad 才允许确认，界面分别显示 mm/度残差。
- 自动订阅 active 控制器的 `controller_state`（旧版本兼容 `state`）读取实际 `joint_names`，按该列表与顺序生成轨迹，不再把 JointState 中额外的手指关节发给只控制 joint1–6 的机械臂控制器。未收到有效列表时手柄不可拖拽，订阅失败显示具体错误。TCP 链含有控制器不接收的关节时拒绝规划并提示检查 TCP link。
- 正运动学和逆解保留 TCP 链上的 fixed joint 与工具偏移；控制器负责但不在 TCP 链上的关节保持当前反馈，其他反馈关节不进入轨迹且不被预览改写。反馈位置缺失、非有限值或关节名重复时拒绝规划，不以零补齐。拖拽期间预览位姿不被实时 JointState 覆盖。
- XYZ 可按 mm、Roll/Pitch/Yaw 可按度数值编辑；数值始终相对 URDF 根坐标系，拖拽坐标系切换只改变手柄轴方向。RPY 使用固定轴 XYZ（Rz·Ry·Rx），内部四元数避免 ±180° 换向和欧拉角奇异；Pitch 接近 ±90° 时显示角度不唯一。松手保留目标标记，未收敛时标记仍保留在期望位姿，不误跟随 IK 残差。
- 点击「确认执行」才按最新反馈重新做 6D 预览校验，然后通过 `position_move.tcp_pose` 将完整 XYZ+四元数交给 MoveIt 的位置、姿态约束规划；Bridge 保留固定 TCP→腕部偏移，校验整条定时轨迹，并以 FK 核对规划终点与实际到位的位姿。夹爪可作为独立目标一起提交，也可单独确认夹爪运动；不参与机械臂 IK。旧 Bridge 缺少 `tcp_pose_supported` 时禁用位姿执行，不回退为位置目标或本地关节目标。
- IK 未收敛时保留预览并在视图内展示原因，禁止确认执行；可用「恢复实时」或 Esc 撤销。
- 确认执行需要会话安全解锁、MoveIt 就绪和新鲜反馈。Bridge 校验当前控制器、模型、起点和目标后才执行。ACK 表示受理，不代表规划成功或实际到位。
- Bridge 只向以 `/joint_trajectory` 结尾且仅含字母数字下划线斜杠的 Topic 发布，并要求该 Topic 已有订阅者；关节名重复、点数/长度不一致、非有限数值以及非严格递增的 `time_from_start` 都会被拒绝。

## 12. 全局工具栏、诊断与 rosbag

- 点位运动抖动可使用 Jetson 独立只读脚本 `scripts/motion_diagnostics/monitor_motion.py` 采集与离线分析：保留完整遥测、规划/执行结果、发布者与源/接收时间，按动作统计误差、速度、sequence 与指令间隔。脚本不发送控制指令；Ctrl+C 仅停止采集。启动与数据边界见 [运动诊断](./motion-diagnostics)。

- “暂停显示”只冻结 WebView 对 Topic、JointState 和硬件状态消息的消费，不断开 Bridge，也不停止后台 rosbag；恢复后从下一条消息继续更新。
- “全部刷新”同时刷新 Topics 和 ROS Control 列表，并复用各自的并发保护。
- “开始录制”通过受约束的 Tauri SSH 命令在 Jetson 执行 `ros2 bag record -a`，输出到 `$HOME/robot-console-bags/robot-console-<时间>`；PID 和输出路径记录在 `$HOME/.cache/robot-console/`。停止时先发送 SIGINT 以便 rosbag 完成索引，超时后才使用 SIGTERM。
- rosbag PID 在停止和状态检查前同时验证进程存在且命令行为 `ros2 bag record`，避免对复用 PID 的无关进程发送信号。断开 Rebotarm Debug Desk 不会自动停止录制；重新连接会恢复显示远端录制状态。
- “诊断快照”保存本机 JSON，包含脱敏后的连接信息、Topics、Controller、micro-ROS Agent、HardwareStatus、选中 Topic 和消息统计；不写入 SSH 私钥路径，大消息预览限制为 4 KiB，文件上限为 5 MiB。
- 在 Motion 点击“重置布局”恢复所有面板尺寸、收起 Controllers 侧栏和输出区并保留当前 Tab；其他页沿用 Topics 默认左右宽度、Topics/ROS Control 分割比例及侧栏/面板展开状态的重置；“设置”可配置自动刷新周期和诊断快照是否包含消息摘要。

## 13. 单元测试覆盖矩阵

| 功能域 | 覆盖内容 | 测试位置 |
|---|---|---|
| 配置 | 默认值、损坏数据回退、旧路径/Topic 迁移 | `src/appLogic.test.ts` |
| 面板 | 默认/持久化状态、三个内容面板与左右侧栏收起、宽高分隔条和尺寸边界、已连接工具条与 Status 卡片的网格区域隔离 | `src/appLogic.test.ts`、`src/layoutLogic.test.ts`、`src/App.test.tsx`、`src/styles.test.ts` |
| 导航偏好 | 旧 dashboard/新 motion 恢复、Motion Tab 与侧栏独立存储、未知或不可读存储回退、无 ROS 时 Motion 可进入而动作门禁保留 | `src/AppNav.test.tsx`、`src/appNavigationLogic.test.ts`、`src/App.test.tsx` |
| Motion 可调布局 | 尺寸持久化与坏数据回退、鼠标/键盘边界、拖拽隐藏/卸载清理、局部与整体复位、日志复位、场景保留 | `src/motionLayoutLogic.test.ts`、`src/MotionLayout.test.tsx`、`src/MotionPage.test.tsx` |
| 工具栏 | 导航职责分离、Topics 与 Motion 分区、Motion 局部 Tab（Robot View / 姿态库 / 动作组）及偏好恢复、全部刷新、实时暂停/恢复、连接配置、设置和布局重置 | `src/App.test.tsx`、`src/toolbarLogic.test.ts`、`src/PositionPage.test.tsx` |
| rosbag/诊断 | 安全命令生成、PID/状态解析、录制启停、诊断脱敏/预览上限/文件校验与导出 | `src-tauri/src/lib.rs`、`src/toolbarLogic.test.ts`、`src/App.test.tsx` |
| 连接流程 | SSH→会话→Bridge→Agent、状态灯/步骤/可读错误/最近主机、JointState 冒烟、实际端口、基础订阅、重连会话数据清理、版本检查与升级提示 | `src/App.test.tsx`、`src/appLogic.test.ts`、`src/bridge.test.ts` |
| Agent | systemd 属性解析、异常 PID、restart 命令 | `src-tauri/src/lib.rs` |
| Status / 日志 | 四 Tab 汇总、键盘/故障跳转、互斥模式与安全门、日志搜索/跟随/下载、轮询并发与会话隔离、文件轮转/来源白名单/大小限制 | `src/statusLogic.test.ts`、`src/StatusPage.test.tsx`、`src/ControlLogViewer.test.tsx`、`src/controlLogLogic.test.ts`、`src-tauri/src/control_logs.rs`、`src-tauri/tests/test_control_logs.py`、`src-tauri/src/lib.rs` |
| SSH 输入 | 用户名目标、setup 路径和 Topic 格式校验 | `src-tauri/src/lib.rs` |
| 本地端口 | 首选端口及占用时自动回退 | `src-tauri/src/lib.rs` |
| Topic | 发现、选择订阅、消息路由、计数和频率、手动/30 秒自动刷新 | `src/App.test.tsx`、`src/appLogic.test.ts` |
| Topic Graph | ROS 图请求、无边界力导向布局、保留斜杠与 Unicode 的完整多行标签及自适应图形、选中后的画布平移、边界外节点拖动及刷新保留位置、Fit/Reset、占位粒子流速、Bridge 过滤、Controller 聚焦、节点订阅和刷新 | `src/bridge.test.ts`、`src/topicGraphLogic.test.ts`、`src/TopicGraph.test.tsx`、`src/App.test.tsx` |
| Inspector | Topic/Node 详情、完整 Topic 名称、JSON 右键字段、图像预览、订阅失败提示 | `src/TopicInspector.test.tsx`、`src/App.test.tsx` |
| 数据采集 | Navigation 入口、配置校验与持久化、Episode 启动/保存/丢弃/结束、并发与旧响应、SSH 参数安全、进程身份、续录检查、正常 finalize | `src/DataCollectionPage.test.tsx`、`src/dataCollectionLogic.test.ts`、`src/AppNav.test.tsx`、`src/App.test.tsx`、`src-tauri/src/data_collection.rs`、`src-tauri/tests/test_collection_remote.py` |
| Monitor / DataGraph | Dashboard/Panel CRUD、Inspector 两级加入、Panel 多序列与四类图表、布局预设（localStorage + JSON 导入导出）、网格拖拽、共享准星、bag `/clock`/stamp 时间轴、播放条（暂停/1x/进度估算）、暂停跟随/冻结窗口、最大化、重置/锁定/紧凑、v1→v2 迁移、转矩 7 Panel、30s 窗口、Jetson bag play | `src/TopicInspector.test.tsx`、`src/monitorLogic.test.ts`、`src/monitorChartLogic.test.ts`、`src/MonitorChart.test.tsx`、`src/monitorTimeline.test.ts`、`src/MonitorPage.test.tsx`、`src/dataGraphLogic.test.ts`、`src/DataGraph.test.tsx`、`src/App.test.tsx`、`src-tauri` rosbag play 测试 |
| 图像 Topic | Image WebSocket 二进制全速传输、动画帧合并绘制、RGB/BGR/RGBA/BGRA/Mono8/Mono16 转换、step/大小端、Canvas 预览及紧凑元数据 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`bridge/easy_debug_bridge/test/test_image_topic.py`、`src/bridge.test.ts`、`src/imageTopicLogic.test.ts`、`src/RosImagePreview.test.tsx`、`src/TopicInspector.test.tsx` |
| 通用 Topic 解码 | 已安装消息类型的嵌套字段、数组、时间与大整数，ControllerState Inspector 路由、错误类型拒绝 | `bridge/easy_debug_bridge/test/test_topic_json.cpp`、`bridge/easy_debug_bridge/test/test_generic_topic.py`（ROS 集成）、`src/App.test.tsx` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Topics Controller 只读浏览、Motion 确认后 Activate/Deactivate、共享状态和操作后刷新、手动强制核验/每秒静默缓存读取 | `src-tauri/src/lib.rs`、`src/ControllerList.test.tsx`、`src/MotionControllersPanel.test.tsx`、`src/useRosControllers.test.tsx`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | transient-local 晚加入 QoS、symlink-install package URI 与目录穿越防护、相对纹理、Base64、JointState 映射、内联/命名材质颜色、异步网格挂载后着色、错误/轨迹提示非重叠布局 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`src/urdfLogic.test.ts`、`src/ViewerHeadsUp.test.tsx`、`src/resourceCacheLogic.test.ts`、`src/urdfAssetLogic.test.ts`、`src/UrdfViewer.test.tsx`、`bridge/easy_debug_bridge/test/test_viewer_transport.py` |
| 电机输入 | 默认 TRACK/Kp/Kd、多电机使能掩码、行程默认 ±0.35、小数输入、有效数值和 Effort 限制 | `src/motorLogic.test.ts` |
| 电机交互 | 独立导航页、7 个默认关节、安全确认、每关节滑块/使能、使用当前位置、20 Hz 流、切页 DISABLE | `src/App.test.tsx`、`src/MotorControl.test.tsx` |
| Fault | 固件 0–11 映射及未知 fault | `src/motorLogic.test.ts`、`src/MotorControl.test.tsx` |
| Bridge 命令 | mode、ARMED、有限值、Effort、关节掩码解析/校验及 sequence 分配 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |
| Joint4 标定 | 状态解析、安全门控、fault 恢复、Trigger 服务白名单、报告校验与导出 | `src/joint4CalibrationLogic.test.ts`、`src/Joint4CalibrationPage.test.tsx`、`src-tauri/src/lib.rs` |
| 运动学 | URDF 关节链/限位解析、TCP link 解析、正运动学、位置/姿态逆解收敛与限位钳制、四元数/RPY 转换、拖拽坐标换算与射线求交 | `src/kinematicsLogic.test.ts` |
| 轨迹规划 | 轨迹控制器识别与优先级、Topic 命名、时长估算、轨迹点构造、fixed joint/TCP 工具偏移、链关节改写与非链关节保持 | `src/trajectoryLogic.test.ts` |
| 轨迹规划 | IK 目标与失败边界、TCP 松手预览后确认、夹爪能力门禁、Controller“轨迹”标记 | `src/trajectoryLogic.test.ts`、`src/App.test.tsx` |
| Bridge 轨迹 | Topic 白名单、关节名/点数/长度/有限值/时间递增校验、错误文案、Duration 拆分 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |
| macOS 安装 | release 构建后安装到 `/Applications`、失败回滚原安装 | `scripts/install-macos-app.node-test.mjs` |
| Bridge 部署 | 参数解析、rsync 参数、远端脚本与校验输出解析 | `scripts/deploy-bridge.node-test.mjs` |

## 14. 测试命令

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

## Teleop Graph 与 ROS 进程日志

- Topic Graph 默认仅隐藏本控制台的 `easy_debug_bridge` 节点及该名称空间下的私有 Topic；STM32 的 `/stm32h723_motor_bridge`、相机 bridge 和用户自定义 bridge 均保留。勾选「显示调试 Bridge」可显示控制台自身节点，原来的显示偏好继续有效。
- 更新 Bridge 后，桌面启动 Bridge、查询/切换控制器、rosbag 和一键 arm 模式时，若没有显式 DDS XML 配置，使用安装包 `config/fastdds_udp.xml` 的 UDPv4 profile，避开残留或已删除的 Fast DDS SHM 锁导致的发现/数据中断。`deploy:bridge --restart` 同样使用目标安装包内的 profile。显式 `FASTRTPS_DEFAULT_PROFILES_FILE` / `FASTDDS_DEFAULT_PROFILES_FILE` 优先；不修改系统服务、不删除 `/dev/shm` 文件、不降低命令新鲜度或安全停机门禁。
- 需要同时更新 `rebotarm-ros2-stack` 的 Teleop 入口和 `joint_state_relay`：正常 SIGINT/SIGTERM 由 relay 和 leader 生命周期适配入口处理，不向已关闭的 ROS context 写错误日志；真正的串口异常、初始化失败和 STM32 JointState 超时仍报错。外部 Star Arm 驱动、串口和关节映射不由本仓改写。
- 验证：Graph 过滤/节点选择的 Vitest、DDS 默认/显式 profile 的 Rust 与部署脚本测试、隔离 ROS Graph 发现/节点详情/节点退出测试；控制栈单独执行模拟 leader/relay 的信号测试，不连接真实串口或发送机械臂指令。

## Bridge 升级进度

连接页升级 Bridge 时实时累积远端构建/校验日志，日志框固定约 10 行高，可滚动、选中复制；默认跟随最新，手动向上滚动后暂停跟随，可通过“跟随最新”恢复。保留最近 2000 行，每行最多 4096 字符，并移除终端控制字符；升级失败保留此前输出和错误，重试连接或新一轮升级清空旧日志，结束后忽略迟到的进度事件。内容超过窗口时连接页本身也可滚动；远端任务仍运行时每 10 秒显示该阶段任务耗时，避免长时间编译看起来卡住。耗时提示表示任务仍在等待，不是整体百分比或完成保证。构建使用 colcon `console_direct+` 输出，stdout/stderr 均保留到升级结果；任务退出后停止提示。重启 Bridge 后最多约 10 秒等待 loopback 监听，仍未就绪则返回日志和具体失败阶段。该流程不启动或切换机械臂控制器。

macOS 已安装应用在升级 Bridge 前按 `NODE_BINARY` → 应用 PATH → Homebrew 常见路径（`/opt/homebrew/bin/node`、`/usr/local/bin/node`）解析 Node，且校验文件存在、为普通文件并有执行权限位。显式覆盖无效时明确报错，不自动换版本；无 Node 时说明已检查的来源。实际 Node 路径显示在部署进度中。仅为部署子进程补齐 Node 所在目录和系统工具 PATH，不修改应用/系统环境，不调用登录 shell。Node 路径包含空格时也作为单个可执行文件传入，部署参数仍使用原有参数数组。

## 控制模式选择与环境清理

- 控制模式区单独显示“当前模式”，以实际 active 控制器为准，状态不可用时显示“待确认”，互斥控制器同时 active 时提示冲突。选择目标 Teleop/Trajectory/VLA 不立即启动；点击“启动所选模式”或“切换模式（先回零）”才执行。不再根据已加载但 inactive 的控制器节点名称推断运行模式。成功退出且新鲜反馈仍为无故障 DISABLE 时，ControllerManager 不可用显示“控制环境已退出（预期）”，不产生退出后的假异常。当前已启用的同一模式不可重复启动；若下位机已经 DISABLE 而控制器仍 active，则显示“输出已关闭”并提供“重建控制会话”，允许手动重建同一模式。固件处于 RETURN 时显示“回零中”，完成 DISABLE 前禁止启动任一目标模式，仍可请求安全退出或在支撑确认后直接关闭输出。
- 操作期间保留模式名称，统一显示切换状态；启动、退出共享同步互斥，避免同一帧重复点击或启动中并发停机。失败文案和实时日志保留。
- “回零并退出控制”请求既有 RETURN→DISABLE，确认输出关闭后才清理进程，不是暂停或保持。“直接关闭输出…”折叠区提供“直接解除电机输出”，跳过回零，仍需现场支撑确认；DISABLE 不清除锁存故障。
- 每次模式切换在 SSH 互斥锁内调用统一清理：读取新鲜 HardwareStatus → 安全停止及 DISABLE 确认 → 停止同域控制器 → 通知旧模式 supervisor 清理 → 验证同域控制器/relay/leader/启动进程无残留。清理失败/超时/归属不可读时中止启动，保留必要控制进程并报错，不强杀未知节点。不会为了模式切换清理摄像头、Bridge、Agent 或其他 ROS 域。
- STM32 可在现场物理重置。下位机已 DISABLE 而旧控制器仍在运行时，先确认持续 DISABLE，再直接清理，不请求旧会话 RETURN。安全停止服务缺失或拒绝时，同样只有连续收到三帧时间戳递增、`mode=DISABLE` 且 `fault_code=0` 的 HardwareStatus 才允许回收旧控制会话；使用 volatile/best-effort 订阅，拒绝重复/倒退时间戳、无反馈、仍在输出或未恢复的故障。不会仅凭 sequence 归零判断重启，也不会因检测到重置而自动启动模式或恢复旧轨迹。
- PID 文件丢失后残留的已知 arm launch / supervisor / relay / leader 进程也会被检查：仅清理当前用户、同 ROS 域、命令匹配且 Linux 启动标识未变化的进程，发信号前再次确认持续 DISABLE 并复核身份。ROS 进程使用 SIGINT，脚本 supervisor 使用已有 SIGTERM 清理流程；等待退出失败时中止，不升级为 SIGKILL，最后仍核验无残留才开始新模式。
- 对继承了忽略 SIGINT 的后台 ROS 启动器，读取实际信号掩码后使用 SIGTERM；先清理它直接拥有且已核验身份、父进程与 ROS 域的 robot_state_publisher、已知 arm spawner 及已识别的 arm 命令子进程，未知子进程会阻止清理。不向整个进程组广播信号，不强杀。原生流程已完成并核验同域清理后，以 `--clean=false` 启动脚本，避免再次执行其旧的全局进程清理及 daemon 重启，保护其他 ROS 域。内嵌 SSH 命令中的进程匹配表达式避免被启动脚本当成真实 ROS 进程，防止清理误伤当前工作流；PID 文件指向其他域的 supervisor 时保留文件并拒绝操作。
- 启停时显示“连接检查 → 安全停止 → 清理旧进程 → 启动控制器 → 核验反馈 → 完成”的步骤图；退出操作只显示停止所需步骤。高亮节点来自本次原生调用的 SSH 实时输出，自检阶段同步显示脚本 `[n/9]` 步骤；失败停在真实失败节点。切换连接或结束调用后丢弃旧进度，不用计时器推算进度。
- 旧 arm launch 的反馈转发子进程支持直接执行脚本、`/usr/bin/python3` 和 `python3` 三种启动形式，仅识别 `microros_stm32h723_bridge/stm32_state_republisher.py` 精确路径；仍校验同用户、同 ROS 域、父子关系、启动时间及新鲜 DISABLE 回执。无法核验子进程身份时显示子进程和父进程 PID 并拒绝清理。
- 实时日志默认跟随当前控制器；切换过程中跟随目标控制器，尚无运行模式时跟随选中的目标。VLA 跟随本次 Trajectory+gravity 宿主日志，避免自动选中另一控制器的最新文件。更换来源时重新启用“跟随最新”；仅用户滚动行为会暂停跟随，内容增加和布局变化不会自动取消。应用重启后，为首次访问的主机建立所有允许日志来源的字节基线，默认不再显示此前内容；新模式启动前同样建立基线，避免丢失本次启动日志。只重置展示窗口，不截断 Jetson 原始文件；每次启动前将旧的固定日志文件原样移动到同目录 `history/`，新建文件接收本次输出，避免相同长度或相同内容的重启日志被旧字节游标隐藏。完整下载只包含本次应用会话的新内容。日志轮转、原地截断后显示新文件内容；日志读取失败不会阻止安全退出或 DISABLE。
- VLA 先重新初始化 Trajectory+gravity 控制栈，再在同一锁内切换到 VLA，确认 VLA 与 gravity active、Teleop/Trajectory inactive 以及无故障 TRACK。切换失败会保留可观测状态，不声称进入目标模式；现场需通过退出入口安全处理。此路径不启动外部 VLA 推理进程。


## MoveIt 一键启动

- Trajectory 自检通过后启动真实 MoveIt，流程图增加“启动 MoveIt”阶段；Teleop/VLA 不启动规划器。仅启动规划器不会执行点位，不会自动勾选安全解锁，也不会创建或切换硬件控制器。
- MoveIt 启动统一由 Status 的 Trajectory 模式流程完成；姿态库不提供重复启动入口。未就绪时继续显示原因，保存姿态不要求启动规划器或解锁运动。
- 在配置的 ROS 域内等待 `/move_action`、`/move_group/get_parameters`、`/get_planning_scene` 就绪。已有就绪规划器直接复用；已有但未就绪的节点只等待，不重复启动。重复的 Action 服务端、启动器提前退出或超时均报错；MoveIt 自身的同名内部节点不会被误判为多套规划器。点位是否可执行继续由 Bridge 的模型、碰撞、起点和硬件安全门判断。
- 本应用启动的规划器保存 Linux PID、启动标识、用户与 ROS 域；切换或退出在 DISABLE 和旧 arm 清理通过后向已核验的启动器发送一次退出信号并等待其进程组退出，避免向启动器与子节点重复广播信号。归属不可读、PID 复用、未知残留或退出超时会阻止后续步骤，不强杀、不接管外部启动的规划器。失败时保留必要进程与日志；重试不会中断机械臂命令流。
- MoveIt 输出记录在 Jetson `~/.cache/robot-console/arm-moveit.log`，Status 日志来源可选“MoveIt 规划器”，支持既有搜索、下载与跟随。旧日志保留在 `history/`。手动兼容启动仍可执行 `ros2 launch rebotarm_moveit_config real_move_group.launch.py`。

## Motion 规划执行终端

- Motion 的 Robot View / 姿态库 / 动作组共用底部独立输出区域，以「执行日志 / 执行报告」Tab 切换。默认显示日志，执行结束不自动切换；编辑区仅保留紧凑状态，点击「查看执行报告」才展开并切到报告。完整报告在底部面板内部滚动，不挤占预览与时间轴；切换 Motion 子页或编辑其他组仍保留最近执行快照，断线/重连清除。两个 Tab 共用可拖动高度与折叠状态，切换时保留日志来源、搜索与滚动位置。日志支持折叠、关键词搜索、跟随最新、手动滚动暂停跟随及导出 `.log`。不遮挡 3D 画布；切换这三个 Tab 后仍可查看同一份点位记录。
- 规划执行过程记录命令 ID、时间、阶段、目标/实测关节、指定/推荐时长、轨迹点数、MoveIt Action 结果和错误码，以及拒绝、取消、反馈故障和停止/到位确认。TCP 拖拽另记录本地位姿预览与 IK 收敛结果，确认后共用规划/执行日志；受理 ACK 不表示到位。
- 下拉切换“MoveIt 原始输出”可查看真实规划器日志（含 OMPL、碰撞和执行报错），复用既有 SSH 搜索/下载入口。只有选择该来源、底部执行日志 Tab 展开且窗口可见时读取文件。
- 过程窗口在当前连接中保留最近 5000 条，重连清空；导出包含保留的全部记录，不受搜索影响（32 MiB 上限）。Bridge 最近 2048 条用于增量同步，每批最多 256 条；窗口溢出有提示。Bridge 端过程记录也写入 ROS 日志与进程输出（常规启动为 `/tmp/easy_debug_bridge.log`，Bridge 重启会替换该输出文件）；长期保留请在重启前导出，非永久无限存储。
- 控制器服务健康检查始终只有一个待处理请求；成功返回后等待 1 秒再查询，慢响应期间不追加请求。失败后按 1/2/4/8 秒退避重试（上限 8 秒），成功后恢复正常频率。请求达到 2 秒即超时，上次成功校验的激活状态仍最多保留 3.1 秒；超时/服务不可用立即失效，退避期间禁止执行，不以持续收到 Topic 作为 active 证明。inactive、类型或接口不符立即阻止执行；硬件、JointState 和 JTC 实时反馈仍要求 1 秒内新鲜。慢查询、故障与恢复按状态变化记录，同一超时只输出一条 controller 告警，不再由 health 重复输出；过期响应不能恢复状态。
- 运动反馈、Action/参数/控制器服务与 watchdog 使用独立的互斥 ROS 回调组，减少图像/拓扑解析阻塞运动状态更新；仍由同一个运动状态机串行处理，不增加并发控制入口。

## joint7 夹爪与位置兼容

- 位置存储升级为 schemaVersion 2，六轴值仍按 joint1–joint6 保存，可选 `gripperPosition` 保存米制单指行程。version 1 自动迁移且不补夹爪值；旧点位与 HOME 显示「保持当前」。编辑和新增可勾选保存夹爪目标，卡片/缩略图展示夹爪姿态。
- 「保存当前姿态」在 Bridge 提供新鲜标定夹爪快照时默认带上夹爪；缺失时明确提示只采集六轴，并可手动填写。保存编辑不执行运动。模型不直接应用 `/stm32/joint_states` 的原始夹爪值；优先订阅 `/robot_feedback/joint_states` 的高频标定位置，状态查询快照作为回退，两者一秒过期失效。右手指随主手指 mimic 联动。
- 夹爪执行额外核对模型标定、有效范围、专用 JTC position+velocity、bit0x40、反馈新鲜度与一致性。未就绪给出原因，旧 Bridge 不静默丢弃夹爪目标。夹爪限幅按当前标定配置（首版不超过 0–50 mm、20 mm/s、40 mm/s²），不采用 URDF 71.5 mm 上限替代标定行程。
- 夹爪 Action 成功后须速度 ≤1 mm/s，连同机械臂停稳持续 200 ms 才报告执行完成；最终夹爪位置误差保留为诊断。取消、故障、断线共享同一运动锁与停止核验。执行完成不等于夹持成功。

### 完整 TCP 位姿目标的验证边界

TCP Pose 执行不保证末端走笛卡尔直线或复现鼠标路径，MoveIt 仍规划关节空间避碰路径。Bridge 只接受 URDF 根坐标系和 joint6 之后的稳定 fixed TCP link（或 joint6 子 link），拒绝可动手指、未知 link、非有限值或无效四元数。完整 Pose 请求始终 plan-only，FK 终点满足 ≤5 mm、≤0.02 rad 才进入 ExecuteTrajectory；成功后仍需实际位姿满足相同门限并停稳。TCP+夹爪规划沿用现有 `arm_with_gripper` 组；已在隔离 MoveIt 环境验证其自动组合机械臂 IK 和夹爪关节采样，无需修改实际控制器配置。

### 时钟同步健康显示

Status 的「硬件健康」使用统一的标题、状态徽章、诊断行和异常原因卡片展示时钟同步，并将同步状态纳入 Tab 汇总；失步显示异常、过期显示注意、等待和不支持显示未知、断开显示空闲。Status 和 Robot View RGBD 区域显示 Jetson 返回的时钟同步状态、关节时间超前/落后毫秒数和异常原因。详情包含反馈接收帧龄、时间代次与可用的固件同步诊断。RGBD 原始错误放在可展开详情内，避免长堆栈遮挡画布。

诊断每秒最多一次，使用独立并发保护；断线、换连接和过期响应不能复用旧的同步成功状态。Mac 不用本机时钟推算 STM32 与 Jetson 的偏差。老 Bridge 明确显示不支持时钟诊断，升级后重连可重新检查；健康提示不替代控制器、硬件和运动安全门。

### RGBD 帧显示与订阅隔离

RGBD 图像使用独立 ROS Context / DDS participant 接收，避免大图像流与 TF、硬件状态共用接收路径。同一组 RGB/Depth/CameraInfo Topic 在多个客户端间共享一套 ROS 订阅，客户端各自保持预览尺寸、帧率、目标坐标系及令牌；取消其中一个不影响其他客户端，最后一个退出后释放相机订阅。RGB/Depth 从三帧队列配对，每组只处理一次；按采集时间重试 TF 最多 150 ms，源帧达到 500 ms 即丢弃。

- 前端按动画帧整体合并完整 RGB/Depth/内参/Pose，只处理最新组。TF 或解码错误立即取消排队的旧成功帧并隐藏旧点云，保留原始错误详情，后续完整成功帧自动恢复。
- 停流后最长 500 ms 未收到有效完整帧即隐藏点云；有 Jetson 打包时 RGB/Depth 较老源帧龄时按帧龄缩短剩余显示期限，帧龄达到 500 ms 即拒绝显示。期限使用单调接收时间计算，延迟绘制、无效帧和错误不能刷新旧点云的有效期。
- 隐藏 Robot View、暂停实时显示、切换配置或断开连接会释放 RGBD 订阅、取消帧处理并清空点云。支持订阅令牌的新 Bridge 只接受当前令牌的成功/错误帧；老 Bridge 按兴趣与配置过滤，不能保证隔离相同配置的旧网络帧。

## Motion 动作组

- Motion 新增「动作组」Tab，按机器人连接配置保存独立动作组文件。支持新建、重命名、复制、保存修改和删除；名称、备注、首姿态准备时长、关键帧、过渡及停留时长均持久化。保存失败保留编辑内容并显示原因；坏文件或无法读取时禁止覆盖，原位置文件不变。
- 从已保存位置选择或拖入姿态，保存六关节及可选 joint7 快照；来源位置修改后明确提示并由用户更新，来源删除后仍保留快照。编辑动作组不修改原位置，执行使用点击时的独立快照。
- 视频剪辑式时间轴展示姿态关键帧、运动片段、停留和播放头；支持拖动时刻/顺序、秒数输入、缩放/横向滚动/吸附/完整显示及撤销重做。第一帧为名义 0 秒，前一帧停留后开始下一运动段。拖动播放头仅预览姿态，不下发电机指令；模型插值不代替 MoveIt 规划路径。
- 所有主要分区沿用 Motion 分隔条可调整、记忆和重置。切换 Tab 或主导航保留未保存编辑；切换动作组时有保存/放弃入口。执行状态与共享日志跨页面持续存在。
- 执行先以准备时长到首姿态，确认到位后逐段 MoveIt 规划、指定时长执行、反馈停稳及停留；名义总时长不含准备、规划和停稳额外耗时。各段均受既有安全确认、反馈、时钟、控制器、模型/关节/夹爪限位及故障门禁约束，指定时长超出速度/加速度能力则失败，不自动改时长。
- Jetson Bridge 拥有整组调度与运动锁，停留和暂停也不能被其他控制任务插入。暂停在当前段停稳后生效，继续前重检；停止使用既有取消与停止确认。失败、取消、断线或心跳失效后不执行后续帧，也不自动重试或续跑。
- 编辑和本地预览不要求连接；执行要求新版 Bridge 广告动作组能力。数据和编排边界、来源快照、保存失败与原子落盘、全组互斥、暂停/取消/失败及断线行为均由单元或隔离 ROS 测试覆盖，真实机器人验收不由一般代码测试触发。

### Pose / Action 动作块工作台

- 「位置」Tab 改名为「姿态库」，原位置文件、连接隔离、HOME 与安全门保持兼容。新建动作组先从姿态库搜索、多选 Pose，按选择顺序创建快照；编辑中可在选中 Pose 后插入，拖入来源姿态也按相同插入规则处理。
- 左侧为动作组与姿态库，中间上方为根据当前 URDF（离线使用内置模型）生成的简化 3D 姿态预览，下方时间轴持续显示；右侧按当前 Pose / Action 展示属性，底部为执行入口与当前结果。多机械臂轨道按各自 Pose 独立预览，不跨轨道插值；未绑定设备模型时明确标注使用当前模型示意，不表示真实安装位姿或联合碰撞场景。各分隔尺寸继续独立记忆；窄窗口属性区移至下方并单独滚动。
- Pose 块区分移动/停留，可拖动排序、用时长手柄或秒数输入修改，支持撤销/重做、缩放、横滚、0.1 秒吸附及完整显示。首姿态独立于名义时间零点；准备时长仍单独配置。播放、0.5×/1×/2×速度和播放头只展示关节线性插值，不请求真实运动或保证规划路径；隐藏页面、窗口不可见或开始实机运动即停止本地播放。
- 「＋ Action」在所选 Pose 后添加相机拍照，可自定义名称、相机轨道、图像 Topic、依赖 Pose 和 0.1–60 秒超时。琥珀色 Action 块与相机轨道、依赖连线持续可见；其宽度表示超时预算而非承诺的采集耗时，总编排时间明确包含该预算。删除 Pose 同时移除依赖 Action，撤销可恢复两者。
- 拍照由 Bridge 在对应 Pose Action 成功、连续停稳及停留完成后订阅新的 `sensor_msgs/msg/Image`。仅接受请求之后采集、相对 Jetson 不超过 500 ms（最多超前 50 ms）、与最新关节反馈时间差不超过 100 ms 的图像；持续检查控制器、时钟、反馈、故障和实测保持基准。原始图像不经过桌面 JSON 传输；编码写盘在独立线程执行，保存成功后才推进下一段。
- 当前支持 rgb8 / bgr8 / rgba8 / bgra8 / mono8，最大 4096×4096、64 MiB。PNG 与实际姿态 `pose.json` 一起提交到 Jetson `$HOME/.local/share/robot-console/captures/<command-id>/<action-id>/`，已有结果不覆盖；界面显示最近采集缩略图和路径。文件包含源图像时间、关节反馈时间、相机 frame、Topic、实际关节位置和速度，便于后续手眼标定；本功能不计算手眼标定结果。
- 未支持拍照的旧 Bridge 明确阻止含 Action 的动作组执行；相机缺帧、过期帧、格式错误、写盘失败、超时、取消和断线均不推进后续 Pose。仍使用 Bridge 整组锁及既有停止核验，桌面不通过定时器调度采集或运动。
- 执行先进入「执行前检查」，检查失败原因直接可见，现场安全确认仍必需。未保存稿明确区分「保存并执行」和「执行当前未保存快照」；保存失败不执行。正在运行的组锁定编辑，其他组仍可独立编排；暂停/继续/停止与结果诊断持续保留。
- 设备轨道保存 ID、名称、类型及设备绑定；旧动作组自动使用当前机械臂轨道。可添加未来机械臂轨道并分配 Pose、删除未使用轨道。「同步点」可选择至少两个不同机械臂的 Pose，保存参与 ID 并在时间轴标记名义等待位置；支持编辑、删除和撤销，删除参与 Pose 时移除对应同步点。当前仅执行一个绑定 `current` 的机械臂及当前 Bridge 的相机；多臂轨道或外部设备明确阻止执行，不把时间轴对齐宣称为多臂联合规划/同步。

动作组配套 Bridge 升级保留连接 Profile 的 JointState、JointCommand 和 HardwareStatus Topic；命令行部署可用 `--joint-state-topic` / `--command-topic` / `--status-topic` 或对应 `BRIDGE_DEPLOY_*_TOPIC` 覆盖，重启前校验为绝对 ROS Topic。现场 `/stm32/status` 不会被升级脚本默认 `/stm32/hardware_status` 替代。
部署构建固定对所选 Bridge 包使用 `--cmake-clean-first`，避免 rsync 保留的源文件 mtime 让内容已变化的文件复用旧对象。其余包和扩展不清理；构建完成仍须分别核对安装二进制、运行进程及 hello 的 build ID。

## 动作组执行结果与完成判定

- 最近一次动作组的成功、失败、取消和受理拒绝持续显示，不因任务离开 busy 状态而消失；明确区分当前编辑稿与执行快照，显示组名、帧号/姿态及准备、运动、停留或暂停阶段。只有本会话仍在运行的任务显示暂停/继续/停止入口。
- 位置误差改为诊断信息，显示目标、实际、有符号差值及参考值；机械臂同时显示 rad/度，夹爪显示 m/mm。新 Bridge 通过 `position_error_check_enforced:false` 明确完成策略；旧 Bridge 未声明时不显示已取消门限。反馈必须是新鲜有效的核验快照，缺失或无效时不沿用上一帧数据。
- 组准备或某段的 Action 成功并确认停稳后，零停留且未预约暂停时直接转段或完成。实际停留/暂停以该时刻实测姿态作为保持基准，位置漂移超过原容差仍立即取消；短暂速度波动先冻结剩余停留并重新连续确认停稳 200 ms，5 秒仍未恢复才失败。不会再次用名义目标的到位位置误差阻止转段。Action 失败、反馈过期、时钟/控制器/硬件故障、停止未确认仍阻止续段，TCP 的独立位姿精度及未编辑轴的规划路径保持约束不变。
- 六轴 MoveIt 规划速度/加速度上限为 2 rad/s 与 2 rad/s²，缩放仍为 1.0；Bridge 按当前模型每轴限幅验证完整轨迹，过短的指定时长仍可能被拒绝。夹爪标定速度/加速度和电机 MIT 增益不变。

- 保持漂移或持续未停稳失败时，结果区单独显示“异常触发快照”：失败原因、触发时间、反馈年龄、保持基准和当时的实际位置/速度。后续取消停稳后的反馈显示在“完成/停止核验快照”，两者分别保存，避免用停止后的低速反馈解释先前的异常。旧 Bridge 未提供触发快照时不补猜原因。
