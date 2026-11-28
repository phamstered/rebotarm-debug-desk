# Rebotarm Debug Desk 基本功能与测试覆盖

更新日期：2026-10-16

产品名：**Rebotarm Debug Desk** · 仓库：[`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)。npm 包名为 `rebotarm-debug-desk`；Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`），文档不在此处静默改代码侧显示名。

本文档记录当前已经实现的基本功能、运行边界以及对应的自动化单元测试。项目由 macOS Tauri 桌面端、React/Three.js WebView 和 Jetson ROS 2 Bridge 三部分组成。

面向操作的模块说明与流程图见 [功能概览](./features)；本文保留测试覆盖矩阵与更细的行为边界。

macOS 本机安装使用 `npm run install:mac`：先编译 release 版，再将
`Robot Console.app` 安装到 `/Applications`，更新失败时恢复原安装。

视觉 Pick 的取消请求现在绑定原抓取任务编号。迟到页面清理或旧按钮请求不能取消后继任务；原生层与 Bridge 都核对编号，Bridge 同时核对所属连接。缺少按编号取消能力的旧 Bridge 会提示升级，原有现场确认和 DISABLE 入口保留。

多窗口功能的 Position/动作组、视觉 Pick、重力辨识、直接 JTC 轨迹与 Joint4 也在首次提交前保存任务来源和编号。桌面重启后恢复占用，仅在用户重连原配置后查询原任务；不会重发目标、轨迹、采样、动作组继续指令或恢复续租。查询缺少原编号、终态或所需证据时保持未知占用；终态核验及记录清理完成后才释放。Bridge 已丢失原任务历史时不会把普通 idle 当作结束，这种情况仍需进一步核验，不能自动重新执行。

多窗口功能的 Motor 连续指令在首次发送前保存恢复记录（原连接身份及任务编号，不保存位置、增益或运动授权）。桌面重启后先恢复未确认占用；不会自动连接，用户重新连接原机器人后仅发送 DISABLE 并等待同连接的新鲜固件序列确认。停止核验及恢复文件清理均成功后才允许新任务；损坏记录、落盘失败或连接身份不匹配时显示原因并保留占用。等待磁盘期间显式 DISABLE 仍可发送。

多窗口功能中，页面重新加载或 WebKit 渲染进程退出后，原生层立即使旧页面身份失效，等待旧订阅清理后允许新页面接入同一连接。其他页面仍可接收共享图像；旧页面运动任务请求取消并保留占用至停止确认，本地标定子进程等待退出后释放占用。恢复页面不会自动恢复运动许可，尚未保存的页面内存状态可能丢失。

多窗口的共享任务状态（运动／控制环境、手眼计算、rosbag、数据采集）在内嵌模式下统一显示于主窗口，功能页不再重复显示。拆出为独立窗口或进入窗口迁移恢复状态时，页面显示自己的任务提示；收回后恢复由主窗口展示。任务错误、结果未确认和取消入口保持可见，任务互斥及安全条件不变。

八个原生功能页的窗口操作统一并入已有标题／工具区，不再显示额外的“页面名、主机、共享连接”横条。内嵌时只显示拆出图标；独立窗口提供连接详情、显示主窗口和收回图标；迁移回滚未完成时用恢复图标替换拆收。Topics 使用现有全局工具栏右侧，Motion 使用现有工具栏，其余页面使用标题栏右侧。图标保留中文可访问名称、悬停说明、键盘焦点及至少 32 px 点击区；采样、保存或控制任务期间禁止迁移，禁用原因可用键盘聚焦查看。断线、迁移恢复和失败仍显示文字，现有任务提示、取消及 DISABLE 不变。窄窗口优先隐藏辅助说明并允许标题区换行，不把图标悬浮在图像上。

各功能页及公共弹窗采用统一的紧凑操作按钮：普通操作 32 px 高，12 px 字号、5 px 圆角；图标按钮为 32 × 32 px，曲线卡片和面板标题栏使用 24 × 24 px 紧凑规格。刷新、复制、导入导出、编辑、删除、缩放等采用一致的线性图标，提供操作名称、悬停说明和键盘焦点；异步操作保持禁用与忙碌反馈。标签页、导航、列表和拖拽手柄保留原有语义布局。开始执行、停止、DISABLE、采样及确认类操作保留文字和既有安全条件；删除确认步骤不变。窄独立窗口的 Graph 区域允许收缩，刷新工具不会被固定最小宽度推到窗外。

Motor 的 POS_VEL「执行目标并保持」由 Bridge 在 ROS 侧每 20 ms 续发已确认的目标，到位后继续保持该目标。页面仍持续续发以维持操作权限，短暂页面/SSH 调度抖动不再直接造成固件 100 ms 续帧租约失效。本机续帧不会延长客户端权限：250 ms 客户端指令超时、离开页面、断开、显式停止或反馈/故障校验失败仍撤销续发并请求 DISABLE。不会自动恢复失效租约或故障后的运动。

## 0. Jetson Bridge 部署脚本

- `npm run deploy:bridge`（`scripts/deploy-bridge.mjs`）用于把本地 `bridge/easy_debug_bridge` 同步到 Jetson colcon 工作区、执行 `colcon build`，并校验安装二进制与 `127.0.0.1:8765` 监听状态。
- 默认不同步删除远端 package 内多余文件；`--backup` 可在同步前打包远端副本；`--restart` 才重启 Bridge（避免把“已编译”当成“当前进程已更新”）。
- 配置有内置通用默认值（host `jetson`，远端 `easy_debug_bridge`、overlay `Project/rebotarm-ros2-stack/install/setup.bash`，均相对远端 `$HOME`；本地 package 相对仓库根目录），可用 flags / `BRIDGE_DEPLOY_*` 覆盖。远端路径可为绝对路径或相对 `$HOME`，拒绝 `~`、`.`/`..`、空段、以 `-` 开头的段和 shell 元字符。`npm run test:deploy` 覆盖参数解析、rsync 参数、远端脚本与校验输出解析，不要求真实 Jetson。

## 1. 连接与会话

- 安装版的 Bridge WebSocket 由 Rust 会话持有，WebView 不再直接建立上游连接。连接代次及窗口身份由原生 IPC 核验，断开使旧请求与在途数据失效。图像仍为二进制；每个消费者只有一个在途拉取，预览队列按流保留最新帧，ACK/任务事件不使用预览覆盖策略。
- 同一 Topic 的组件订阅可按消费者名称合并，手眼 RGB 与其他观察组件分别持有兴趣；最后一个 Image 消费者释放时才取消上游订阅。普通 Topic 按现有 Bridge 能力保留上游订阅至断连。跨 IPC 的排队与传输耗时计入反馈/图像新鲜度，不把晚收到的旧帧重置为新鲜。

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
- 页面导航只保留在左侧 Navigation，**Status** 为第一项，其后为控制模式、Topics、Motion、Monitor、数据采集、手眼标定、Motor 和重力辨识。Topics 集中 Graph / Inspector、Topic 列表与 Controller 只读浏览；Motion 提供 Robot View / 姿态库 / 动作组 三个局部 Tab、可折叠 Controllers 状态侧栏和共享运动日志。数值曲线在 Monitor 导航页。顶部工具栏不再重复品牌或导航。
- **Status** 页复用现有连接态并增强详情：SSH/隧道、Bridge WS + hello、micro-ROS Agent（`check_micro_ros_agent` / `restart_micro_ros_agent`）、HardwareStatus（成功时「无故障 · mode」、失败时 fault 描述）、JointState 冒烟与 Hz、`check_ros_controllers`、ROS_DOMAIN_ID；USB CDC 经 SSH `probe_jetson_usb`（MCU `0483:5740`、串口、RealSense `8086:*`）仅「刷新检测」；控制模式页的 Teleop / Trajectory 与硬件区的 RealSense 卡片经 `probe_arm_mode` / `start_arm_mode` 一键拉起（SSH BatchMode，优先从当前 ROS setup 目录定位工作区，可用 `LEADER_FOLLOWER_WS` 覆盖，并兼容旧 `leader_follower` 目录；启动前读取新鲜 HardwareStatus，拒绝未恢复的锁存故障；停止旧 Teleop / Trajectory 前调用现有硬件 safe_stop（按当前增益执行 RETURN → DISABLE），等待 STM32 DISABLE 确认后仅通知启动脚本清理，不发送孤立 HOLD；安全停止被拒绝或确认超时时保留命令进程并报错；SSH 侧互斥保护并等待脚本完整自检与非零命令确认后才报告启动成功，超时保留 PID 供「停止」处理）。回零停不下来时可选择「解除输出并停止」，确认现场支撑后由控制器 `~/disable` 服务持续发送零输出 DISABLE，收到 STM32 回执后才停进程（需要支持该服务的 ROS 控制插件）；服务缺失或回执失败时不会改用外部发布者或强杀。一键 Teleop 执行 `scripts/start_arm_teleop.sh --position-controller=teleop --gravity=true --gripper=true --clean=false --start-leader=true`。一键 Trajectory 执行 `scripts/start_arm_teleop.sh --position-controller=trajectory --gravity=true --clean=false`，并按新鲜硬件使能掩码的 bit0x40 选择 `--gripper=true/false`，默认同时启用独立的 `gravity_compensation_controller`；仍等待启动脚本完成控制器状态自检后才报告成功。**VLA** 卡片经 `switch_ros_controllers` 启停 `vla_position_controller`（互斥 `arm_teleop_controller` / `arm_trajectory_controller`，保持 `gravity_compensation_controller`）；启动时与 Teleop/Trajectory 一样，先安全回零、确认 DISABLE、清理并核验旧模式，再以 Trajectory+gravity 初始化新控制环境，在同一原生互斥锁内切到 VLA；不复用旧命令状态，初始化/清理失败则中止；成功后校验 controller active（及可用时的 TRACK）；`fault_code=11` 禁用启动类按钮。可选采样 `/vla/joint_chunk`（`VlaJointChunk`）。Monitor 提供 `+VLA` 模板（`positions[0..5]`）。完整用法见 [VLA 使用指南](./vla)。无一键升级全部或自动刷写 STM32。
- Status 分为「连接 / 硬件健康 / 控制模式」三个 Tab；硬件健康包含 USB、Hardware、时钟同步和 RealSense，控制模式包含 ros2_control、ROS 就绪及当前运行模式卡片（未启用模式时仍显示前两张）；默认打开连接。Tab 按卡片状态聚合，异常优先于注意、未知、正常、空闲，隐藏分区仍持续更新汇总；支持左右方向键、Home/End。Fault 芯片会自动打开硬件 Tab 并高亮 Hardware，HOLD / 故障提示在所有 Tab 保留。
- 独立控制模式页的「模式预设」保留互斥模式条与停止/解除输出确认；控制日志统一进入底部 Terminal。「查看日志」打开当前会话的全部来源，可筛选 Teleop、Trajectory / VLA、拖动示教、MoveIt、ROS Controller 和 RealSense。原生采集不依赖当前页面、页签或窗口是否可见。

Robot View 左臂腕部点云默认使用 `/cameras/left_arm/wrist/` 下的彩色图像、对齐深度和 CameraInfo；一键 RealSense 启动 ROS 栈的 `left_wrist_camera.launch.py`，启用深度对齐和时间同步，并把 `camera_link` 接到相机的 `left_arm/wrist_link`。Bridge 对三个流分别选择兼容的可靠性，均以 `VOLATILE` 订阅，兼容 RealSense 图像与 CameraInfo 不同的 durability；点云帧最多等待 150 毫秒获取采集时刻 TF。若 500 毫秒内有成功帧，短暂 TF 失败不会中断上一帧；持续失败会隐藏过期点云并显示错误，避免与实时 URDF 姿态错位。点云开关、着色、点大小和近远距离控件可交互；尚未收到完整 RGBD 帧时显示等待提示。修改过的自定义 Topic 配置不会被默认迁移覆盖。启动文件需先安装到 Jetson 的 `rebotarm_gazebo` 包。
- ROS 源文件由原生 Terminal 采集器按游标增量读取，来源白名单、32 MiB 源日志下载上限及超时保持有效。Terminal 保留预算、截断提示、筛选、归档与导出规则见[全局 Terminal](#全局-terminal)。下载源日志不应用界面的搜索条件；保存对话框等待期间断线、切换机器人/会话或隐藏窗口会取消旧上下文的下载。日志操作不启停 ROS 或机械臂。
- 已连接工具条与 Navigation 标题共享顶部行高度，两侧底部分隔线始终对齐；窄窗口时状态灯换到下一行并同步撑高标题区。导航列表与主页面内容在标题区下方独立滚动，不与连接控件重叠。
- 已连接顶部工具条提供「断开并重连…」、连接配置、设置、压缩状态灯（含 ROS 就绪 / Bridge 版本徽章 / Fault 芯片 / Domain 提示）、连接名、隧道端口、Agent 与断开；全局工具栏保留全部刷新、实时显示暂停/恢复、rosbag 录制、诊断快照与重置布局。
- Topics 页的 Topics、ROS Control、Inspector 三个区域可独立展开/收起；左右侧栏也可整列最小化并恢复，状态保存在本机。Topics 与 ROS Control 会自动使用另一面板释放出的高度。
- Topics/ROS Control 之间可上下拖动调整高度；左右侧栏边界可横向拖动调整宽度，面板尺寸会持久化到本机。分隔条支持键盘方向键微调。Topic 名称与类型悬停显示全称。
- Topics 下方显示 `/controller_manager` 当前加载的 ROS Control Controller、类型及 active/inactive 等状态。桌面每秒经现有 WebSocket 读取 Bridge 共享缓存，不再为列表刷新启动 SSH/ROS CLI；Topics 自动刷新间隔单独设置。
- ROS Control 标题栏提供手动刷新按钮，与展开/收起按钮并列；手动与自动刷新具有并发保护。自动轮询静默更新，不触发“全部刷新”或“刷新 Controllers”的忙碌显示；手动刷新和操作核验仍显示进行中状态。健康结果默认仅显示稳定的“最新”摘要，快照年龄与后台查询进度可展开“查询详情”查看，故障、过期及真实 Controller 状态变化立即展示。手动刷新及控制器操作前后等待请求进入后新发起的 ROS 查询，切换期间发起的查询不能充当切换后核验。
- Topics 的 Controller 卡片提供「查看 Graph」聚焦关联节点、Topic 和连线，以及「管理」跳转控制模式；本页只读。Controller 管理在独立控制模式页完成，见下方说明。
- Controller 名称和操作类型在 Tauri/Rust 后端校验，拒绝包含 shell 特殊字符的输入。列表与运动健康检查共用单个常驻 ROS 客户端，沿用 2 秒请求上限、3.1 秒状态有效期和失败退避，保留既有 active、接口认领和故障门禁。新鲜成功结果不显示“重试等待”，仅失效状态显示退避等待时间。缺少 MoveIt 支持时仍可查询列表；缺少 Controller Manager 消息支持或旧 Bridge 时明确提示升级，不回退到冷启动 CLI 查询。
- 兼容 Jetson 当前 Humble `ros2controlcli` 的超时参数类型缺陷：不显式传入 `--switch-timeout`，使用其内部浮点默认值，并由外层进程提供 10 秒超时保护。
- Controller 列表区分首次等待、查询中、服务不可用、查询超时、数据过期及 Bridge 不支持。失败后保留同会话最后成功列表并标明年龄/错误，只供查看；不再把一次查询失败直接显示成控制器离线。成功空列表明确显示暂无 Controller。连接代变化清除旧列表，过期数据禁止 Controller 切换及当前模式确认。
- Bridge 可订阅 Jetson 当前 ROS 环境中已安装类型支持的消息类型。已知的基础消息保留原有字段格式；其余类型通过 ROS 2 运行时字段描述递归转换为 JSON，包括 `control_msgs/msg/JointTrajectoryControllerState` 的嵌套字段和数组。类型支持缺失或请求类型与已发现的 Topic 不符时显示具体错误。

### Motion 工作区

- Motion 可在 ROS 未就绪时进入，查看已保存位置及就绪原因；执行继续要求连接、MoveIt、active 控制器、新鲜反馈、时钟和既有安全确认。
- Topics 的 Controller 卡片提供「查看 Graph」和「管理」导航；实际启停在控制模式页，确认前重新核对状态；运行中的运动或其他控制任务会阻止切换。控制模式页同时保留整栈启动、安全退出与解除输出。
- Motion 顶部展示机械臂/夹爪控制器、MoveIt、关节反馈和时钟状态；Robot View、姿态库与动作组共用全局 Terminal 的 Motion 日志。左侧 Controllers 默认收起，可通过工作栏“面板”展开；已有展开偏好继续恢复。
- Controllers 宽度、执行报告高度和点位列表/编辑区可拖动分隔条调整。方向键每次调整 10px，Shift + 方向键每次 40px，Home/End 到边界，双击分隔条恢复该项默认值。窄姿态库页改为列表/编辑上下分区。
- Robot View 画布铺满内容区；「运动控制」「时钟同步 / RGBD」「TCP / 关节操作」支持画布内浮窗。紧凑工作台的 TCP / 关节操作默认停靠右侧，可切换浮窗，也可直接拖动标题脱离停靠（单击标题不会切换）；未保存偏好时运动状态和 RGBD 默认折叠，异常仍在状态摘要或面板标题提示。拖动标题移动，右下角手柄调整大小；标题和缩放手柄也支持方向键每次 10px、Shift 每次 40px。每个浮窗可折叠，画布顶部按钮可重新展开并置于最前；「重置浮窗」恢复默认位置、大小和展开状态。折叠保留当前编辑内容，不改变点云订阅或执行状态。面板内滚动/点击不操作相机，拖动浮窗不下发运动。
- 分隔尺寸独立保存于 `robot-console-motion-layout`；浮窗位置、大小和折叠状态保存于 `robot-console-viewer-floating-panels-v1`，重启恢复。缩小窗口限制浮窗及其标题在画布内，面板内容独立滚动；仅显示尺寸约束不覆盖宽屏偏好。在 Motion 点击全局“重置布局”恢复分隔尺寸和所有浮窗并恢复图标导航、收起 Controllers 和输出区，保留当前 Tab 与编辑内容。
- 导航页、Motion Tab 与 Controllers 展开状态独立记忆。Motion 默认 Robot View；旧 `dashboard` 导航标识继续表示 Topics。连接后默认跳 Status 的既有独立设置继续适用。
- RGBD 仅在 Motion → Robot View、窗口可见、实时显示和 RGBD 配置开启时订阅；姿态库 Tab、Topics 和其他页释放当前客户端兴趣并清空点云。已加载的 Robot View 场景仍保留，隐藏时停止绘制并取消未结束的拖拽。

### Motion 紧凑工作台

- Motion 将连接状态、全局工具和三个视图 Tab 合并为单条工作栏。主机按钮展示就绪或当前异常，展开可查看 SSH/Bridge/Agent/硬件/时钟及连接操作；Controllers 位于“面板”，刷新、实时显示、录制、诊断和布局重置位于“更多工具”。显示暂停和录制中保留常驻标记。后台轮询与原有安全核验保持运行，切换/断线清除会话数据的行为不变。
- Motion 默认图标导航，其他页面保留自己的展开偏好。“专注模式”临时隐藏导航、资源、属性、Controllers、Robot View 操作窗和展开的执行报告；退出恢复原布局，不清除未保存编辑或预览。主动打开属性/输出/Controllers 时退出专注。正在运行的任务、取消/停止、执行前检查和故障摘要持续可见。
- 动作组左侧使用“动作组 / 姿态库”资源 Tab 和名称搜索；属性默认收起，单击块选择并本地预览，双击或菜单“属性”展开。属性可固定，下次恢复；未固定时仍保留当前会话展开状态。预览与时间轴支持分屏、仅预览、仅时间轴，资源区也可单独收起。窄宽度的属性区使用可关闭抽屉，不额外增加一行编辑区。
- 动作组、源姿态、Pose/Action 块、轨道和时间轴空白支持右键菜单；工作区与卡片提供 `⋯` 替代入口。菜单支持 Shift+F10、方向键、Enter、Escape 和点击外部关闭。工具弹层也支持 Escape 收起并返回入口，不要求先点击或聚焦弹层内容；已由上层对话框处理的按键不再关闭其后的工具弹层。文本输入保留系统右键操作。Pose 可替换快照、前后插入、复制、添加拍照和删除；Action 可修改属性/依赖、复制和删除。删除 Pose 同步移除依赖 Action/同步点，撤销可恢复。轨道仅允许删除未使用轨道，且至少保留一个机械臂轨道。
- 持久化动作组/姿态删除继续确认，切换未保存动作组继续提供保存/放弃/返回。编排块修改使用既有撤销记录；运行组锁定编辑，菜单和快捷键不能绕过。实际运动与 Controller 切换不由右键快捷触发，继续使用明确入口及原安全确认。
- 工作台快捷键：⌘/Ctrl+S 保存动作组，⌘/Ctrl+Z 与 Shift+⌘/Ctrl+Z 撤销/重做，Space 播放/暂停本地预览；选中且聚焦的编排块可用 Delete/Backspace 删除并撤销。输入框、对话框、菜单、隐藏页面或拖动中不截获这些快捷键；不映射真实运动或停止指令。保存反馈位于组名旁，失败时可从「查看操作日志」读取完整原因，仍禁止执行未保存版本。
- Robot View 画布右键或 `⋯` 提供适应模型、正/侧/俯视图、网格/坐标轴开关和打开 TCP 操作区。这些操作不修改目标关节或下发运动，青色球与 XYZ/RPY 微调、确认执行、保存实测姿态保持可用。
- 紧凑面板偏好使用 `robot-console-workspace-*` 本地键，分隔尺寸和浮窗位置沿用原键。专注模式不覆写这些偏好。输出区默认折叠，展开偏好继续记忆；报告可随时通过报告栏或“查看执行报告”打开。正常保存不再显示占据整行的提示。

## 4. Topic Graph、Inspector 与 Monitor

- Motion 集中 Robot View、「姿态库」和「动作组」Tab；Topics 中心固定展示 Topic Graph，数值图表使用 Monitor 导航页。Topic Graph 展示 ROS Node、Topic，以及 Publisher/Subscriber 的有向连接关系，视觉语义与 `rqt_graph` 一致。「姿态库」保存当前连接（SSH 主机、用户、端口）下的六轴及可选夹爪点位，HOME 固定为 `builtin:home`，界面和保存文件都不能删除、改名或覆盖它；数值尚未从 Jetson SRDF 同步时显示「待同步」。每个点位卡片按 URDF 关节链和保存关节值显示简化 3D 姿态：立体连杆、关节、基座地面网格及末端红 X / 绿 Y / 蓝 Z 方向轴，保存夹爪目标时展示手指开度。HOME、编辑和动作组预览共用这一展示；使用固定斜视角并自动取景，不加载 mesh 或为每张卡片占用 WebGL 上下文。缺失或无效姿态显示「无姿态」，预览不下发运动；没有实机 `robot_description` 时用内置运动学模型。「保存当前姿态」位于 Robot View → TCP 操作区最下方，点击打开命名、可选夹爪及备注窗口；窗口固定点击时的实测快照，后续反馈和未执行的 TCP 预览不会改写它。读取 1 秒内完整的 joint1–joint6，优先配置的 JointState，否则用 `/joint_states`。重力补偿下手把手臂拖到目标位置后可以保存，只记录关节角，不下发运动。未连接时连接页的「管理姿态库」打开同一份数据。新姿态从 Robot View 保存；姿态库只保留执行、编辑和删除，不再提供“手动新增”或“启动 MoveIt”。
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
- **运动误差看板**：Monitor 点击「+运动误差」添加三张图：六轴轨迹跟踪误差 `JTC desired.positions − actual.positions`（rad）、六轴反馈差值 `JTC actual.positions − 配置 JointState.position`（rad）、消息头时间差与桌面接收时间差 `JTC − STM32`（ms）。控制器固定读取 `/arm_trajectory_controller/controller_state`；JointState 跟随当前连接配置，按 `joint1`–`joint6` 名称匹配，不包含夹爪。兼容新版 JTC `reference/feedback` 字段（旧字段数组为空时使用）。同一条 JTC 消息计算跟踪误差；反馈差值使用桌面收到的两路最新数据，**未做时间对齐**，不等同于轨迹跟踪误差，也不保证复现 Bridge 内部的采样或告警峰值。消息头时间差不是端到端延迟，JTC 更新时间与 STM32 源时间的语义不同。
  看板默认散点，缺失、非有限数值、重复关节名或数组长度错误不补零；缺少源时间戳、任一路接收数据超过 1 秒、两路源时间差达到 1 秒时不生成反馈差值。重复源时间戳不续期、不生成重复点；时间戳回退、实时/Bag 模式切换会重置诊断缓存并清除诊断曲线。暂停保留历史，恢复后等待两路新采样；断线重连清空点和配对状态，保留布局。源数据状态会在停止来数后显示过期；订阅失败显示原因。布局与图表设置沿用 Monitor 持久化、共享准星和 30 秒窗口。看板为只读诊断，不修改运动保护；Bridge 现比较 JTC actual 与 JointState Broadcaster `/joint_states`，六轴阈值为 `0.02 rad`；本看板保留原始 STM32 差值用于底层链路诊断，不是当前 Bridge 门禁比较源，也不是轨迹跟踪容差。
- Monitor Bag 回放：经 Tauri SSH 在 Jetson 执行 `ros2 bag play <path> --clock`，曲线仍走 Bridge 实时订阅；本机解析 bag / 下载 / 索引未实现。路径校验与录制相同（拒绝 `~`、`.`/`..`、shell 元字符等）。
- `sensor_msgs/msg/Image` Topic（包括 `/camera/color/image_raw`）在数据 Tab 使用 Canvas 实时预览，支持 rgb8、bgr8、rgba8、bgra8、mono8、mono16 及对应 OpenCV 8UC/16UC1 编码、行步长和大小端转换。
- 图像只投递给明确订阅的 WebSocket 连接；取消订阅或断线后释放兴趣，最后一个兴趣消失后释放对应 ROS 图像订阅。仅在 Topics 的 Inspector 数据 Tab 可见且实时显示开启时订阅选中图像；切主导航、折叠 Inspector/右侧栏、切详情 Tab、暂停实时或隐藏窗口会取消图像订阅，返回自动恢复。已取消兴趣的残留帧不会重新填充预览。
- Image 数据由 Bridge 使用 WebSocket 二进制帧全速传输，帧头保留 JSON 元数据、像素保持原始字节，避免 Base64 膨胀和大 JSON 解析；Canvas 使用浏览器动画帧合并绘制，不丢弃 Bridge 消息且不影响 Topic 频率统计。元数据展示尺寸、编码、step、时间戳与原始字节数但不展开二进制内容。
- Graph 可以展示 ROS graph 中的全部 Topic；实时内容解析要求对应消息类型支持已安装在运行中的 Bridge ROS 环境。64 位整数超过 JavaScript 安全整数范围时以十进制字符串传输，非有限浮点数转为 `null`。

## 数据采集（LeRobot v3）

- Navigation 的「数据采集」页对接已安装的 `rebotarm_vla`；Mac 不需要 ROS 或 LeRobot。先在 Status 启动包含夹爪的 Teleop 和 RGB 相机，再配置数据集 ID、Jetson 保存目录、任务、FPS（默认 20）、腕部及可选固定相机 Topic。
- 数据源默认 `/stm32/joint_states`（MCU 经 Agent 的 stamp；host 时钟的 `/joint_states` 不适合 stamp 门禁，表单仍可改）、`/arm_teleop_controller/commands`、`/gripper_teleop_controller/commands`。旧偏好中的 `/joint_states` 会迁移到 `/stm32/joint_states`。关节状态须包含 `joint1..joint6` 与米制 `gripper_finger_left_joint`（0.05 m 打开、0 m 关闭）。采集器输出七维 state/action，夹爪按 0 打开、1 关闭归一化。
- 「启动采集器」通过 Tauri `data_collection_action`，source 连接 Profile 的 ROS overlay，调用 Jetson 上的 Python（默认 `venvs/lerobot/bin/python`）执行 `python -m rebotarm_vla.lerobot_recorder --no-keyboard`。必须预先安装 `rebotarm_vla` 与兼容的 LeRobot v3；启动会实际导入 LeRobotDataset 检查后端依赖并报告错误，不安装软件。若虚拟环境包含 NVIDIA `cu12/lib` 或 `cudss/lib`，仅为预检和采集器子进程补充这些现有库路径，保留 ROS 的库路径。
- 通过固定 `/lerobot_recorder/start_episode`、`save_episode`、`discard_episode`、`status` Trigger 服务控制 Episode；桌面原生会话统一查询采集状态、帧数、已保存 Episode、FPS、任务和日志，每次查询完成后间隔 5 秒，页面退出不停止公共查询。查询失败或超过 20 秒时显示状态待确认并禁止操作；旧数据只保留供查看。操作成功后重新查询共享状态，不用命令返回值替代当前状态。仅开始 Episode 需要本会话收到 JointState；状态、保存、丢弃和结束在缺少反馈时仍可用。无有效帧时提示检查 Topic、同步与日志。
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

<span id="_6-mit-电机控制"></span>

## 6. MIT / POS_VEL 电机控制

- Motor 页把**驱动模式**（MIT / POS_VEL）与**执行状态**分开。选择驱动模式只编辑候选；“实际驱动”显示固件读回结果，点击“应用驱动模式…”并确认现场支撑后才发起配置。
- 模式切换过程统一写入底部 Terminal 的 `Motor` 来源，包含申请、固件事务变化、应用结果和停止确认。后续停止反馈、刷新能力或重新打开确认框不会覆盖失败原因；关闭页面或断开连接仍保留应用内历史。页面保留当前固件事务、失败状态与可操作的停止按钮。日志只记录实际收到的状态，不补造底层步骤。POS_VEL 仍展示所选轴的固件已验证范围与当前反馈；error 10 表示范围不符，应用不会自动移动或放宽限位。
- 配置先发送 DISABLE，等待本次停止后的新鲜、真实关闭反馈，再逐轴写寄存器并读回。模式申请、服务 ACK、消息发布均不代表切换成功；部分失败或结果未知时保持禁止开始，需核验停止后重新操作。
- 旧 Bridge / 固件继续使用 V1 MIT。POS_VEL 需要新 Bridge、ROS V2 消息/服务及支持固件；本连接一旦观察到 V2，能力丢失或过期就禁止新控制，不自动退回 MIT。当前固件默认不开放未经台架验证的 POS_VEL 轴，joint7 不默认开放。
- 关节目标区与控制区在宽屏分为两栏；窄窗口控制区在前。MIT 和 POS_VEL 分别保留参数草稿，改变模式、所选轴或参数后需要重新确认；运行中冻结本次参数快照，停止后重新确认才能开始。
- Position 提供滑块及数值输入，min/max 按当前连接的 URDF 关节名读取并只读显示，MIT / POS_VEL 共用同一模型范围，只约束滑块编辑。旋转关节直接使用 `<limit lower/upper>`（rad）；原始 joint7 夹爪使用同一 URDF 的 MicroRosSystem 标定比例、偏移及 position 行程，将 URDF 与标定行程的交集换算为电机 rad，负比例会交换上下界。不会把夹爪米制行程直接当作电机角度。
- 尚未收到 URDF、缺少有效限位、连续/mimic 关节或夹爪标定不完整时，min/max 显示为空并禁用滑块，说明原因；数值输入保持既有规则。重新连接会清除旧模型范围，不使用内置预览模型兜底。模型更新只刷新滑块范围，不改写目标/所选轴或自动下发；“使用当前位置”仍由用户显式写入反馈。支持自然输入负数、小数及逗号小数。
- MIT 保持 HOLD / TRACK / RETURN，默认 TRACK、`Kp=8`、`Kd=2`；Velocity / Kp / Kd / Effort 全局共享，Effort 限制 `[-1,1] Nm`，数值必须有限。上位机不另加 MIT Position / Velocity / Kp / Kd 限幅，固件仍最终校验。
- POS_VEL 首版只支持 TRACK / HOLD，参数为逐轴 Position 和正速度上限（rad/s），范围来自固件能力状态；不显示 MIT Kp / Kd / Effort。HOLD 由固件锁存新鲜当前位置，未选轴通过显式掩码保持关闭，不把零目标当作“未选”。
- 主按钮为 MIT“开始控制”、POS_VEL“执行目标并保持”，HOLD 为“保持当前位置”。点击一次后界面后台仍以 20 Hz 续发本次获准快照；频率、sequence、lease、反馈龄及 Topic 放在“控制详情”。发送 ACK 不表示到位，到位也不自动结束保持。
- “停止并 DISABLE”常驻，不需要安全勾选。停止、离开页面、能力失效、首帧或许可结果未知时停止续发并请求关闭输出；重新显示页面不恢复发送。DISABLE 清零控制字段，发送三帧且每帧分配新 sequence。
- 停止反馈区区分“已请求 DISABLE”与“已确认输出关闭”。V2 完成还要求 `disabled_verified`：全部七轴的新鲜关闭反馈均来自本次真正 CAN 停止之后。真实停稳和负载支撑仍需核对现场，不能把输出关闭当作保持姿态。
- Bridge 保留订阅者、新鲜 status / JointState（<1 s）、固件 active 轴及确认门禁；V2 另校验 boot、配置代次、连接来源、租约与范围。切换、租约、持续流纳入原生任务锁及重启恢复，未知结果不释放占用；Rust 不自动补发旧目标。
- V1 `/stm32/joint_commands` 永远只表示 MIT。新 V2 默认使用 `/stm32/joint_commands_v2`；停止仍走 V1 mode=3。恢复旧 Controller / Teleop / JTC 前必须整组读回 MIT 且释放 V2 来源与租约；本次不增加这些模块的 POS_VEL 路径。

当前验证使用隔离 ROS 模拟器与固件主机测试；这不等于电机的速度单位、方向、零速、载荷、在线切换及停止行为已通过台架验收。旧固件断流 500 ms 可锁存 fault 11 并保持 HOLD，不能笼统承诺“500 ms 后自动 DISABLE”；新固件允许 fault 11 下幂等 DISABLE，但不清故障锁。

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

## 10. Joint4 标定已移除

上位机不再提供 Joint4 Calibration 页面、导航、重力辨识跳转及专用采样/导出 IPC。旧页面偏好回退到 Topics，旧原生窗口布局中的 Calibration 项被忽略，选中项回退到 Status，其他窗口布局保留。手眼标定和全臂重力辨识继续可用。

旧 Joint4 任务的停止、终态核验及恢复记录兼容逻辑仍保留；未知任务不能因页面删除而解除占用。已有 Controller 冲突检查仍生效。本次移除不卸载 Jetson Controller，也不删除用户已导出的报告。

## 11. TCP 拖拽轨迹下发

多窗口功能已给直接 JTC 下发增加原生任务编号、跨窗口占用、取消入口与终态证据校验。所属页面退出会请求取消，发布 / 取消 ACK 不解除占用；重连后仅查询原任务。此路径要求 Bridge 声明 `trajectory_task_supported`，已接入 arm/gripper 控制器的 ROS 发布与反馈；旧 Bridge 或缺少可选编译依赖时显示更新提示。取消会请求 DISABLE 并等待序列、JTC 末点和独立反馈确认。常用 MoveIt 点位和 Pose 执行仍使用原有入口；环境部署与实机验证记录见下文。详见[多窗口实现记录](./multiwindow-implementation)。

### Robot View 关节联合调整

- 在 Robot View 选择「关节调整」，可分别输入 joint1–joint6 的目标角度（度），也可选择或点击模型关节后用滑块调整。所有已编辑轴同时预览，切换所选关节保留其他目标；未编辑轴继续显示实时反馈。夹爪（joint7，`gripper_finger_left_joint`）为独立直线自由度，以单指行程 mm 调整；fixed 与 mimic 关节不提供独立操作。
- 调整仅预览，反馈不会覆盖已编辑目标。「恢复实时」、Esc、切换操作方式、隐藏视图或模型/连接变化会清除预览；显示实际角度、目标和所选关节 URDF 限位。连续关节不强制回绕。
- 运动时长默认 5 秒，接受可用 ROS 时间表示的有限正数，不再限制为 0.1–120 秒，也不以低于推荐时长为由拒绝。MoveIt 规划返回的原始时长在界面显示，仅供参考；轨迹可伸长或压缩，速度除以时间倍率、加速度除以倍率平方。Bridge 使用当前受控关节限速/限加速度，对整段三次/五次插值样条做保守上界校验，超限或无法验证时拒绝执行；夹爪还校验整段插值不越过标定行程。运动时长不含规划和到位核验耗时，长运动总超时随指定时长增加，5 秒会话心跳要求不变。
- 勾选工作区安全确认并点击「确认执行」后，一次提交所有已编辑关节及运动时长。Bridge 从新鲜实测状态补齐其余轴目标，并添加 ±0.001 rad 路径保持约束；全部六轴已编辑时不添加保持约束。无法在约束内避碰则规划失败；约束不构成硬件零误差保持保证。
- 定时执行使用 MoveIt `/move_action` 的 plan-only 结果，校验路径、起终点和时序后，通过 `/execute_trajectory` 一次执行完整轨迹。规划与执行共享运动锁、心跳和取消；执行前再次核对新鲜反馈、实测起点与 MoveIt 起点容差，已取消或断线的规划不进入执行。Action 成功并由新鲜反馈确认停稳后报告执行完成，最终关节位置误差仅作诊断。
- 保留 active JTC、六关节 position+velocity 接口、TRACK/故障、反馈新鲜度/一致性和实测停稳等安全条件；不恢复已删除的 JTC 参考连续性检查。需要 Bridge 广告 `joint_targets_supported` 和 `motion_duration_supported`，缺失时禁用确认执行；`/execute_trajectory` 未就绪时显示具体原因。其他 URDF 旋转关节可预览；真机执行允许 arm 六轴及经过能力核验的独立夹爪。

规划诊断写入既有 Motion 日志和 Jetson ROS 日志，沿用 command_id 与会话隔离。`plan_request` 记录规划组、pipeline、5 秒规划上限、尝试次数、plan-only、自动/显式执行时长及关节限幅；结果记录请求耗时和 MoveIt 自报规划耗时。plan-only 路径校验还记录点数、首末时间、时间缩放倍率及每轴位置/速度/加速度的轨迹结点峰值（不代表连续样条峰值）。每轴最多一条摘要，不全量打印轨迹点。`plan_rejected` 指出 preflight、轨迹结构/点解码、时序/样条、起终点、TCP 或保持约束阶段；样条拒绝包含从 0 开始的段索引、时间、关节、单位、端点 p/v/a、限幅及递归子段的导数端点或保守控制点上界。无法证明满足上限与已确认超限分开描述。自动时长（如视觉 Pick）先验证 MoveIt 原始时长；仅连续样条速度/加速度超限或无法证明满足动态上限时，按 1.25 倍递增时长、最多延长 8 次（总倍率小于 6），每次从原始轨迹重新缩放时间、速度和加速度并完整复验。路径、位置与 effort 不变；行程越界、无效/缺失数据或其他门禁错误不触发自动重试。`plan_retime` 记录每次失败原因和新时长，成功时 `plan_timing` 记录最终倍率及调整次数。手动指定时长仍直接校验并在不满足时拒绝，不自动修改。起终点、TCP、反馈、取消和其余执行门禁继续生效。

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
- “开始录制”通过受约束的 Tauri SSH 命令在 Jetson 执行 `ros2 bag record -a`，输出到 `$HOME/robot-console-bags/robot-console-<时间>-<随机标识>`；身份记录存于 `$HOME/.cache/robot-console/bag-processes-v1/`，兼容 PID 与路径文件仍保留。停止时先发送 SIGINT 以便 rosbag 完成索引，超时后才使用 SIGTERM。
- 录制/回放按系统启动编号、进程启动时刻和随机继承标识确认归属；停止通过 Linux pidfd 绑定实际进程后再次核验身份，包含原启动进程退出后的已标记子进程。断开 Rebotarm Debug Desk 不会自动停止录制；重新连接会恢复显示远端录制状态。
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
| Monitor / DataGraph | Dashboard/Panel CRUD、Inspector 两级加入、Panel 多序列与四类图表、布局预设（localStorage + JSON 导入导出）、网格拖拽、共享准星、bag `/clock`/stamp 时间轴、播放条（暂停/1x/进度估算）、暂停跟随/冻结窗口、最大化、重置/锁定/紧凑、v1→v2 迁移、转矩 7 Panel、30s 窗口、Jetson bag play | `src/TopicInspector.test.tsx`、`src/monitorLogic.test.ts`、`src/monitorChartLogic.test.ts`、`src/MonitorChart.test.tsx`、`src/monitorTimeline.test.ts`、`src/motionErrorMonitorLogic.test.ts`、`src/MonitorPage.test.tsx`、`src/dataGraphLogic.test.ts`、`src/DataGraph.test.tsx`、`src/App.test.tsx`、`src-tauri` rosbag play 测试 |
| 图像 Topic | Image WebSocket 二进制全速传输、动画帧合并绘制、RGB/BGR/RGBA/BGRA/Mono8/Mono16 转换、step/大小端、Canvas 预览及紧凑元数据 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`bridge/easy_debug_bridge/test/test_image_topic.py`、`src/bridge.test.ts`、`src/imageTopicLogic.test.ts`、`src/RosImagePreview.test.tsx`、`src/TopicInspector.test.tsx` |
| 通用 Topic 解码 | 已安装消息类型的嵌套字段、数组、时间与大整数，ControllerState Inspector 路由、错误类型拒绝 | `bridge/easy_debug_bridge/test/test_topic_json.cpp`、`bridge/easy_debug_bridge/test/test_generic_topic.py`（ROS 集成）、`src/App.test.tsx` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Topics Controller 只读浏览、Motion 确认后 Activate/Deactivate、共享状态和操作后刷新、手动强制核验/每秒静默缓存读取 | `src-tauri/src/lib.rs`、`src/ControllerList.test.tsx`、`src/MotionControllersPanel.test.tsx`、`src/useRosControllers.test.tsx`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | transient-local 晚加入 QoS、symlink-install package URI 与目录穿越防护、相对纹理、Base64、JointState 映射、内联/命名材质颜色、异步网格挂载后着色、错误/轨迹提示非重叠布局 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`src/urdfLogic.test.ts`、`src/ViewerHeadsUp.test.tsx`、`src/resourceCacheLogic.test.ts`、`src/urdfAssetLogic.test.ts`、`src/UrdfViewer.test.tsx`、`bridge/easy_debug_bridge/test/test_viewer_transport.py` |
| 电机输入 | 默认 TRACK/Kp/Kd、多电机使能掩码、目标草稿、小数输入、有效数值和 Effort 限制 | `src/motorLogic.test.ts` |
| 电机交互 | 独立导航页、7 个默认关节、安全确认、URDF 滑块范围及夹爪单位换算、模型/连接更新、每关节选择、使用当前位置、20 Hz 流、切页 DISABLE | `src/App.test.tsx`、`src/MotorControl.test.tsx`、`src/motorRangeLogic.test.ts` |
| Fault | 固件 0–11 映射及未知 fault | `src/motorLogic.test.ts`、`src/MotorControl.test.tsx` |
| Bridge 命令 | mode、ARMED、有限值、Effort、关节掩码解析/校验及 sequence 分配 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |
| Joint4 历史兼容 | 旧布局迁移、入口移除、原生任务恢复与停止核验 | `src/App.test.tsx`、`src-tauri/src/session/layout.rs`、`src-tauri/src/session/leased_recovery.rs` |
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

连接页升级 Bridge 时，stdout/stderr 与阶段提示统一进入底部 Terminal 的 `Deploy` 来源；原生进程持续采集，窗口隐藏不暂停。失败后保留构建过程和错误，重试不删除历史。连接页提供日志入口，保留连接阶段和错误操作。远端任务每 10 秒输出该阶段耗时，不表示百分比或完成保证。构建仍使用 colcon `console_direct+`；重启后最多约 10 秒等待 loopback 监听。该流程不启动或切换机械臂控制器。

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
- 控制模式页通过“查看启动及 ROS 日志”打开全局 Terminal 并筛选当前/目标控制器来源；VLA 使用 `trajectory` 宿主日志。原生服务每轮用一次 SSH 读取允许来源的增量，窗口隐藏、切页或收起不暂停。应用首次访问主机建立字节基线，新模式启动前也建立基线，不截断原文件；文件轮转、原地截断以设备号、inode、大小及指纹识别。重连复用同主机游标，避免重放本次应用已读内容。源日志下载沿用本次应用基线和 32 MiB 上限；读取失败不阻止安全退出或 DISABLE。
- VLA 先重新初始化 Trajectory+gravity 控制栈，再在同一锁内切换到 VLA，确认 VLA 与 gravity active、Teleop/Trajectory inactive 以及无故障 TRACK。切换失败会保留可观测状态，不声称进入目标模式；现场需通过退出入口安全处理。此路径不启动外部 VLA 推理进程。


## MoveIt 一键启动

- Trajectory 自检通过后启动真实 MoveIt，流程图增加“启动 MoveIt”阶段；Teleop/VLA 不启动规划器。仅启动规划器不会执行点位，不会自动勾选安全解锁，也不会创建或切换硬件控制器。
- MoveIt 启动统一由 控制模式页的 Trajectory 模式流程完成；姿态库不提供重复启动入口。未就绪时继续显示原因，保存姿态不要求启动规划器或解锁运动。
- 在配置的 ROS 域内等待 `/move_action`、`/move_group/get_parameters`、`/get_planning_scene` 就绪。已有就绪规划器直接复用；已有但未就绪的节点只等待，不重复启动。重复的 Action 服务端、启动器提前退出或超时均报错；MoveIt 自身的同名内部节点不会被误判为多套规划器。点位是否可执行继续由 Bridge 的模型、碰撞、起点和硬件安全门判断。
- 本应用启动的规划器保存 Linux PID、启动标识、用户与 ROS 域；切换或退出在 DISABLE 和旧 arm 清理通过后向已核验的启动器发送一次退出信号并等待其进程组退出，避免向启动器与子节点重复广播信号。归属不可读、PID 复用、未知残留或退出超时会阻止后续步骤，不强杀、不接管外部启动的规划器。失败时保留必要进程与日志；重试不会中断机械臂命令流。
- MoveIt 输出记录在 Jetson `~/.cache/robot-console/arm-moveit.log`，全局 Terminal 可筛选 `moveit` 来源，支持搜索、下载与跟随。旧日志保留在 `history/`。手动兼容启动仍可执行 `ros2 launch rebotarm_moveit_config real_move_group.launch.py`。

## Motion 规划执行终端

- Motion 的 Robot View / 姿态库 / 动作组统一使用全局 Terminal 查看过程日志。Motion 页只保留可折叠、可调整高度的执行报告；点击“查看执行报告”展开最近执行快照，切换子页和编辑其他组保留报告，断线/重连清除报告。日志保留独立于报告及 3D 画布，关闭报告不会停止日志采集。
- 规划执行过程记录命令 ID、时间、阶段、目标/实测关节、指定/推荐时长、轨迹点数、MoveIt Action 结果和错误码，以及拒绝、取消、反馈故障和停止/到位确认。TCP 拖拽另记录本地位姿预览与 IK 收敛结果，确认后共用规划/执行日志；受理 ACK 不表示到位。
- 在全局 Terminal 选择 `moveit` 可查看真实规划器输出（OMPL、碰撞和执行报错），选择 `Motion` 查看结构化过程；二者持续接收，搜索、清屏、暂停跟随仅改变当前窗口的展示。
- Bridge 最近 2048 条用于增量同步，每批最多 256 条；原生运动共享缓存仍为 5000 项 / 2 MiB，新到记录同时复制至全局 Terminal。上游/本地窗口溢出明确提示。Bridge 过程记录也写入 ROS 日志与进程输出（常规为 `/tmp/easy_debug_bridge.log`）；Terminal 的内存、归档与导出限额见下文。
- 控制器服务健康检查始终只有一个待处理请求；成功返回后等待 1 秒再查询，慢响应期间不追加请求。失败后按 1/2/4/8 秒退避重试（上限 8 秒），成功后恢复正常频率。请求达到 2 秒即超时，上次成功校验的激活状态仍最多保留 3.1 秒；超时/服务不可用立即失效，退避期间禁止执行，不以持续收到 Topic 作为 active 证明。inactive、类型或接口不符立即阻止执行；硬件、JointState 和 JTC 实时反馈仍要求 1 秒内新鲜。慢查询、故障与恢复按状态变化记录，同一超时只输出一条 controller 告警，不再由 health 重复输出；过期响应不能恢复状态。
- 运动反馈、Action/参数/控制器服务与 watchdog 使用独立的互斥 ROS 回调组，减少图像/拓扑解析阻塞运动状态更新；仍由同一个运动状态机串行处理，不增加并发控制入口。

## joint7 夹爪与位置兼容

- 位置存储升级为 schemaVersion 2，六轴值仍按 joint1–joint6 保存，可选 `gripperPosition` 保存米制单指行程。version 1 自动迁移且不补夹爪值；旧点位与 HOME 显示「保持当前」。编辑和新增可勾选保存夹爪目标，卡片/缩略图展示夹爪姿态。
- 「保存当前姿态」在 Bridge 提供新鲜标定夹爪快照时默认带上夹爪；缺失时明确提示只采集六轴，并可手动填写。保存编辑不执行运动。模型不直接应用 `/stm32/joint_states` 的原始夹爪值；优先订阅 `/robot_feedback/joint_states` 的高频标定位置，状态查询快照作为回退，两者一秒过期失效。右手指随主手指 mimic 联动。
- Bridge 的控制器反馈一致性检查使用 JointState Broadcaster `/joint_states` 与 JTC `actual.positions`，按关节名匹配；六轴容差保持 0.02 rad，夹爪容差保持 0.001 m。Broadcaster 已处于 ros2_control 单位，夹爪不重复标定。缺失、过期、时间戳无效、重复帧停滞、关节不完整/重复或非有限值会阻止受理，运动中沿用取消流程；不回退到原始 STM32 Topic。两路均来自控制器侧状态，但发布时间/到达时间仍可能不同，本次没有实现严格同周期配对。STM32 原始反馈继续承担时钟、限位、规划起点与停稳/到位检查，硬件故障、使能及 Controller active 检查保持。
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


## 拖动示教（六轴柔顺 + 手动夹爪）

- 控制模式 → 模式预设选择「拖动示教」。启动需确认现场已支撑机械臂与物体、运动区域安全；先安全停止旧模式，再调用 `--mode=teaching --clean=false`。提交控制操作前只读检查配套控制栈支持 `teaching_gripper.py check-manual`；旧版本、检查失败或超时会显示具体原因并释放尚未提交的任务占用，可在修复环境后重试。实际执行仍再次检查能力；控制操作一旦提交，异常或超时继续保留未确认占用。不启动 MoveIt 或主臂 relay。
- 六轴 Kp=0、Kd=1，保留重力补偿和每轴 ±10 N·m 前馈限幅。夹爪 Kp、Kd、effort 全部为零，不主动保持开度，可用手拨动；机械摩擦仍然存在。示教不启动夹爪轨迹控制器，底层拒绝七轴 position/velocity 及夹爪 effort 接管。
- 控制模式页删除张开、闭合目标、夹取和停止夹爪控件，仅保留「保存当前姿态」。保存同一帧六轴与夹爪实测开度；需要电动抓放时先安全退出示教，再启动 Trajectory。
- 就绪核验包括只读 `drag_teaching` / `manual_teaching_gripper` 标记、重力控制器 active、运动控制器及夹爪命令接口未占用、新鲜标定反馈、七轴无故障 TRACK。旧客户端电动夹爪请求明确拒绝。
- 退出示教不会主动回零。退出前必须托住机械臂与物体，经支撑确认后 DISABLE，并确认反馈才清理控制进程。不能直接从示教切到其他模式；手动拖动没有规划避碰，松手不保证机械臂或物体保持原位。
- Motor 页禁止本会话示教运行期间直接下发电机命令。控制模式页与 Motion 保存姿态都从 `/robot_feedback/joint_states` 同帧捕获六轴与米制夹爪，反馈超过 500 ms 或不完整时拒绝，不依赖 MoveIt。之后可在 Trajectory 模式使用姿态库/动作组回放；本模式不自动录制连续轨迹。
- 实时日志使用独立 `arm-teaching.log`。验证覆盖手动模式就绪、无电动夹爪控件、七轴姿态保存、旧版本拒绝与支撑退出；控制栈另有硬件写帧回归及隔离模拟 MCU 测试，不代表真机拖动手感或负载验证。

### 桌面物体三维框（几何检测）

Motion → Robot View 的 RGBD 面板新增「物体三维框」，默认关闭；需要支持检测的 Bridge，且 RGBD 目标坐标系为 `base_link`。打开后显示分离桌面物体的绿色线框和临时编号，可切换编号及可见尺寸。检测开关本身只观察，不发送运动命令；点击选择和抓取入口见下方「点击选择、抓取候选与分段视觉 Pick」。

Jetson 对同帧对齐深度反投影、转换到 `base_link`，经过 ROI、体素降采样、水平桌面 RANSAC、桌面上方点筛选和欧式聚类生成 AABB。最多显示 20 个物体，检测请求频率上限为 10 Hz；实际频率由图像、TF 和计算耗时决定。没有可靠桌面、没有物体或检测失败时清空框并显示原因。框和点云在空帧、TF/解码错误、超时、隐藏页面及断线时一起更新或清除。

编号使用多帧跟踪：按位置（最大关联距离 10 cm）、尺寸和框重叠进行全局一对一匹配；新目标连续出现 3 帧后才分配编号。确认目标短暂漏检后保留 1.5 秒内部记录，在此期限内重新匹配可恢复编号；漏检帧不显示旧框。待确认记录最多保留 350 ms，漏检会重新累计连续帧；最多保留 60 条记录。超时、重订阅、时钟失步/回退或检测异常后重新确认。框使用当前观测位置，平滑仅用于内部匹配。编号不是持久身份，接触、遮挡和相似物体交叉仍可能误关联。尺寸为**可见点云范围**，单视角看不到的底面、背面不会推测补全；平面状观测的最小尺寸取体素尺寸。点云近远裁剪仅改变 Mac 显示，不改变 Jetson 检测 ROI。

配置文件为 Bridge 安装目录的 `share/easy_debug_bridge/config/object_detection.json`，可通过 ROS 参数 `object_detection_config` 指定独立文件；在下一次开启检测时加载。`roi_min/max`、`table_min_z/max_z` 使用 `base_link` 米制坐标；默认 ROI 为 `[-0.8,-0.8,-0.5]`～`[0.8,0.8,1.0]`，桌面高度范围为 -0.3～0.1 m，需按现场桌面调整。其他参数控制体素、桌面距离/角度、物体离桌高度、聚类距离、最小点数和最大尺寸；非法配置明确拒绝订阅。

适用首测：固定观察姿态下，桌面上相互分离的不透明积木或盒子。接触/堆叠物体可能合并，透明和反光物体可能缺深度；机械臂或其他结构进入 ROI 也可能被识别成物体。检测没有语义分类或机器人自身点云过滤，也不把框自动加入 MoveIt 碰撞场景；启用受控抓取前需另行核验碰撞环境。

### 点击选择、抓取候选与分段视觉 Pick

Robot View 开启物体三维框后，点击框内部选择当前订阅中的目标；选中框变为橙色，RGBD 面板显示编号、候选抓取中心和预张开行程。候选用橙色点、坐标轴及预抓取连线显示。点击选择及生成预览都不会下发电机命令。深度框消失后保留已选目标；RGB 身份失效时隐藏候选并禁止执行。重新订阅或断线清除选择，编号不能跨订阅使用。

候选由可见 AABB 的较窄 XY 方向生成俯抓方向，抓取坐标系 +X 为闭合方向、+Z 向上，提供 0°/90° 两种轴对齐偏航之一。未标定时仅显示可见顶面的几何候选，不把零偏移当作真实 TCP 标定。此方法没有补全被遮挡物体，不保证几何区域为可抓物体；首版可见宽度限定为 15–130 mm，实际执行还要满足硬件标定的夹爪范围。

Jetson 的 `config/visual_pick.json` 默认 `calibrated:false`、`scene_verified:false`，执行按钮禁用，服务端也拒绝执行。实机必须先实测并核验：相机外参、抓取中心到 TCP 的固定变换、桌面高度、夹爪零行程开口和开度映射；确认桌面及相关障碍物已进入 MoveIt Planning Scene。`grasp_to_tcp` 表示**抓取坐标系到所选 TCP link** 的刚体变换，四元数 xyzw；不是机器人基座下的绝对 TCP 位姿。文件中的单位为米。`table_z_m` 为水平桌面高度；单指行程按 `(物体宽度 + opening_margin_m - jaw_gap_at_zero_m) / 2` 生成预张开，闭合按 `(物体宽度 - compression_m - jaw_gap_at_zero_m) / 2` 生成，不能用未经实测的零开口替代标定。正向行程增大须对应双指开口增大。默认配置仅为模板，不能通过直接改两个布尔标记代替上述工作。可在 Bridge 启动时用 ROS 参数 `visual_pick_config` 指定独立文件；每次预览和开始会重新读取所指文件。

具备标定、场景核验、Trajectory 控制器、MoveIt、夹爪和新鲜反馈后，确认现场安全及夹爪为空，点击「接近、抓取并抬升」。执行先张开夹爪，逐段重新观测同一目标并接近预抓取位，再下降、闭合和抬升保持。预览仅在服务端保留 1 秒；开始时核验预览序号、目标订阅/编号、标定配置和目标变化，过期或目标移动超过 2 cm 需重新预览。每段接近的目标位移上限 20 mm，下降 10 mm，旋转 0.15 rad；这些是**目标步长**，MoveIt 的关节空间避障路径不保证笛卡尔直线，也不保证实际路径长度等于目标步长。接近和下降各最多 80 段；每段结束必须收到序号更新的新观测才能继续，等待新帧超过 500 ms 中止。任务执行预算为 180 秒，超时请求取消，停稳确认另计。需要保持目标可见，腕部相机被工具遮挡时会取消，不使用旧框继续下降。

任务在 Jetson 维护跨段运动锁，直接电机/轨迹、其他点位和重力辨识请求不能插入；DISABLE 保持可用。目标消失、观测/TF 过期、时间代次改变、形状突变、相对起点移动超过 5 cm、单段内移动超过 2 cm、客户端心跳超过 3 秒、运动失败或超时都会停止后续段并请求取消。停止未确认时保留锁并显示原因。隐藏页面、关闭点云/检测或断开连接会取消当前客户端的抓取任务。关闭夹爪后抬升使用最终核验的 TCP 目标，不继续追踪已随夹爪移动的物体。

抓取执行的诊断沿用 Motion 日志：`pick_frame` 记录当前目标编号、RGBD 订阅/帧序号/时间代次、相机与目标坐标系、RGB/Depth/TF 时间戳、观测年龄、物体框以及该已发送点云帧实际采用的相机到目标坐标系变换。`pick_config` / `pick_geometry` 记录抓取中心到 TCP 变换、桌面/抓取深度/预抓取间距、夹爪参数、抓取/预抓取与 TCP 目标、当前 TCP 和距离（米）、姿态误差（rad），四元数顺序 xyzw。`pick_segment` 用子 command_id 关联 opening/approaching/descending/closing/lifting 及具体目标；`pick_step` 记录每次新观测后的实际/完整目标 TCP、距离与步长，分段实际下发目标见对应子任务。终态 `pick_result` 保留失败前阶段。预览轮询不会刷这些执行日志，日志不更改控制行为。

夹爪预张开先于机械臂接近，第一条 `-vp-1` 若是 gripper 目标，失败时尚未发送机械臂接近动作。MoveIt 成功返回单个 t=0 轨迹点时，仅对夹爪单关节目标启用“无运动核验”：轨迹点必须有限、在标定行程内、导数为零，规划点和最新实测值都须在目标 0.5 mm 容差内。Bridge 不下发 ExecuteTrajectory，仍持有运动锁并等待连续 200 ms 新鲜到位及整臂停稳反馈；漂移、过期、故障或取消均不得报告成功。其他单点规划仍拒绝；`plan_point` 会打印首末点的有界数组（单点仅一条），`plan_joint_goal` 给出实测值、目标差值及容差，便于判断是否已在目标范围。截图中的预抓取/抓取连线是候选预览，不代表已执行轨迹。

「抬升完成」只表示相关运动 Action 成功且反馈停稳，**尚未通过力/触觉或物体跟随验证夹持成功**。本阶段抓起后保持，放置需要下一步指令。当前验证包括隔离的模拟运动适配器执行全流程及故障/取消回归、真实 Bridge 的预览与未标定执行拒绝；不代表已完成实机抓取标定或抓取成功验证。

### RGBD → 近距 RGB 目标交接

点击三维框后，Bridge 使用该已发送 RGBD 帧的 RGB、内参、采集时刻 TF 和物体框初始化颜色/轮廓跟踪，为本次选择生成固定 UUID。连续至少 3 帧 RGB 区域与对应深度顶面一致后，状态由「核验中」进入 RGBD；光学距离低于 0.25 m，或已核验目标的深度缺失/无效时，切换 RGB。交接沿用 UUID 和初始抓取偏航；不会因点云重新编号自动改选其他物体。选中面板显示 RGB 区域、UUID、模式、置信度及阻止执行的原因。原有点云仍按自身期限隐藏，不显示推测点云框。

首版适用于高饱和度、颜色可分离的桌面物体（例如绿色方块），使用所选区域学习颜色，不扫描整幅图后选择任意同色物体。相机运动通过采集时刻 TF 投影预测补偿；局部颜色轮廓须与预测形状、面积和位置一致。遮挡、轮廓合并、位置跳变、来源/内参/分辨率/时间代次改变会锁定「身份待确认」。清除后重新选择，或明确选择另一物体，才会建立新绑定；不会自动换目标或恢复下降。颜色和几何无法辨别外观完全相同且无可观测差异的物体替换，不能把跟踪状态当成物理身份的绝对证明。

RGB 身份保持本身不提供新深度。首版近距米制位置采用**初始化时深度核对的水平固定顶面**与当前 RGB 像素射线求交，仅适用于静止物体、近垂直俯视（光轴离竖直向下不超过约 10°）、已实测的相机/TCP 变换。`rgb_tracking.plane_verified` 默认为 false；此时可以观察 RGB 身份交接，禁止 RGB 接近。现场核验固定水平顶面假设、相机内外参与 TCP 后才可设为 true，并清除后重新选择；原 `calibrated`、`scene_verified`、控制器、新鲜反馈、现场确认和碰撞门禁仍须通过。RGB 期间目标尺寸/高度保持初始化值，不冒充实时深度测量。

RGB 接近的目标步长最多 3 mm，开始前须已对齐姿态；毫米级 TCP 目标的 MoveIt 位置约束半径随目标距离缩小（3 mm 目标使用 0.75 mm 半径），避免起点落入原 3 mm 目标区域而生成零位移规划；每段仍由 MoveIt 规划并校验。RGB 接管最多 90 秒，累计下发的接近目标步长最多 0.15 m（不是实际避障路径长度）；目标 XY 相对初始修正最多 20 mm，相邻帧修正最多 10 mm。`rgb_tracking.confirmation_frames`（3–10）、`handoff_distance_m`（0.15–0.5）、`max_seconds`（1–90）、`max_travel_m`（0.001–0.15）可在服务器配置中收紧。首版不从未知单目尺度直接盲降，不估计移动物体的高度，也不验证抓取成功。

RGB 初始化使用三维包围盒八个角点的投影范围，颜色学习及候选关联同时要求深度点属于所选三维框，允许旋转方块的轮廓不填满轴对齐包围框；完成初始化后仍按已学习轮廓执行严格遮挡/合并检查。第一次身份失效原因会保留，后续图像过期不会覆盖它。候选预览本身也受 500 ms RGB 期限约束，即使没有收到后续跟踪帧也会失效。

点击物体框内部或编号/尺寸标签均可选择。空闲时再次点击同一物体会先释放旧 UUID，再用新鲜观测建立新身份并重新累计多帧核验；不必先清除选择。快速切换选择时，预览和释放按顺序处理，迟到响应不会清除新目标或恢复旧候选。执行期间仍禁止切换，选择不会下发运动。

RGB 采集时刻 TF 尚未到达时，跟踪线程保留同一张图像、内参和对应深度，在最多 150 ms 内重试该时间戳，不追逐不断更新的最新图像。重试不延长 500 ms 观测期限；持续缺少 TF 仍使身份失效并阻止执行。

RGB 与 Depth 回调异步到达时，所选目标使用独立的最多 6 帧深度历史，按时间戳匹配（差值不超过 50 ms），最多等待 150 ms 后再判定缺深度。该历史不因点云预览消费配对帧而被清除；时钟代次改变时清空。

视觉抓取停止前的 `pick_guard` 记录实际被拒绝的观测（UUID、模式、身份/几何就绪、RGB/Depth/TF 时间及变换），避免用上一张成功帧解释停止原因。跟踪的 `diagnostic` 包含深度是否缺失、尺寸/时间戳不匹配、有效采样数量/比例及顶面高度差；`handoff_reason` 保留首次切入 RGB 的原因、距离、阈值和当时诊断。它们仅用于排查，不改变 RGB 接管、标定或停止规则。`plan_no_motion` 明确标识夹爪已到位且没有下发轨迹。

## Motion URDF 模型分析

Motion → **URDF** 与 Robot View 同级，使用当前连接的 `/robot_description`（配置的 URDF Topic）及既有资源通道。页面是只读模型分析器：结构树、3D 模型和参数/XML 相互定位；不修改远端文件、不发布关节或轨迹指令。未收到模型时显示等待状态，不替换成示例机器人。

- 结构树按 Link → Joint → Link 展示装配关系；Visual、Collision、Inertial 是独立子项，无名多碰撞体保留索引。可搜索、按类型筛选、折叠；点击模型选择 Link，切换“碰撞体”显示后点击选择单个 Collision。
- 参数保留原始 XML，区分“配置 / 默认 / 未配置”；长度和角度同时显示 m/mm、rad/度。Joint 展示 parent/child、origin、axis、limit、dynamics、mimic；几何展示尺寸、mesh URI、scale、材质及纹理；Inertial 展示质量、原点和完整六项惯性。扩展标签可通过原始 XML 查看。
- 可选择外观、碰撞体、叠加和坐标系预设；支持全景、聚焦、仅选中和子树隔离。关节选中时显示轴向箭头、转动范围圆弧/当前方向或移动行程。选中 Link/Inertial 时可显示质心、惯性坐标系及有效张量对应的等效均匀椭球；椭球并非真实外形。
- “零位”显示 URDF 装配关系及 mimic 偏移，零位超限会提示。“实时姿态”只读跟随现有 JointState，暂停、缺少独立关节或反馈超过 500 ms 时隐藏实时模型。“手动预览”只改变本页姿态，按声明范围调整 revolute/prismatic，continuous 提供 ±π 的本地预览范围；mimic 按 multiplier/offset 联动。floating/planar 暂不支持姿态预览，显示警告和配置。
- 基础检查包括无效 XML、重名、无效父子引用、多父/多根/循环、mimic 引用错误、零轴、限位错误、无效数值和几何尺寸。错误阻止加载 3D，但仍可查看参数和 XML；惯性无效/退化和缺少 Collision/Inertial 单独提示。资源加载失败显示具体 URI，可重试。
- 面板可收起，通过拖动结构树右边界、参数面板左边界调整宽度；分隔线支持左右方向键微调（Shift 加大步长）、Home/End 到边界、双击恢复默认宽度。布局偏好跨模型/会话保留，窄窗口参数区采用抽屉并保留边界拖拽；调整时保留中央视图空间，隐藏页面或关闭面板会结束拖拽。渲染按变化触发；页面隐藏时取消未完成加载、释放本页场景，返回时复用连接级资源缓存。断开或模型变化清除旧模型/预览；不会改变 Robot View 的姿态、材质或运动目标，也不会启动 RGBD。

碰撞几何叠加不执行自碰撞/环境碰撞检查，不读取 SRDF 允许碰撞矩阵，不代表规划安全或物理模型已验证。验证覆盖模拟多碰撞体模型、mimic、资源取消、过期反馈、异常模型及浏览器布局；硬件运动不是本功能的验证手段。

RGB 跟踪采用独立于点云计算的线程，按最新帧最高 30 Hz 处理；RGB 跟踪图像预览仍最高 10 Hz，点云识别仍最高 10 Hz。相机采集参数不变，实际跟踪频率取决于来源、TF、深度到达和计算耗时。已进入 RGB 接管时不再为缺失深度等待 150 ms。

仅观测过期时，500 ms 后进入「等待观测」，保持选择 UUID，但立即撤销身份/几何可用状态，禁止执行并使进行中的 Pick 取消。恢复窗口从最后有效观测起最多 2 秒；只有运动任务空闲、控制器/时钟/反馈正常、六轴及夹爪连续停稳 200 ms 后，才允许原身份连续至少 3 帧重新核验（跟随 confirmation_frames）。等待/恢复中不能执行，恢复后只恢复预览，必须重新点击开始；遮挡/歧义、坐标系/内参/时间代次变化或长时中断仍需重选。500 ms 运动新鲜度门禁不变。桌面本地超时进入等待，单张迟到帧不能恢复候选，硬失效原因保持锁定。

Motion 日志 `rgb_tracking` 按状态变化及最多每秒一次记录 UUID、模式、源时间戳/帧龄、跟踪序号、TF/深度等待、CV 耗时及原因；等待耗时为最近一次等待的诊断值，不代表每帧固定延迟。

### 上位机手眼标定

连接页也可从「手眼标定 / 离线样本」进入；断线后样本保留在本次应用会话中。Navigation →「手眼标定」提供与 RViz 对应的 Target、Context、Calibrate 三步操作。

- 连接后的内容区与离线页面均可纵向滚动，滚动条位于页面右侧；图像、样本列表和求解结果不会被窗口裁切。内容区可用键盘聚焦滚动，窄窗口按上下布局排列。查看历史样本后点击「检测标定板」会切换为最新检测图。
- **Target**：ChArUco / ArUco Grid、三种字典、行列数、实测格子/标记尺寸及旧版排列；可生成并保存 PNG 标定板。打印后必须核对实际边长，尺寸不包含纸张白边。首个样本后锁定板参数与坐标配置。
- **Context**：Eye-in-hand / Eye-to-hand，RGB 与 CameraInfo Topic、测量关节 Topic、Sensor 光学帧、End-effector、Robot base 及导出用 camera body 帧。Frames 列表通过只读 TF 查询刷新，允许手动填写，不依赖 MoveGroup 或 RViz 的 SRDF 下拉框。Object frame 来自本地标定板检测。
- **Calibrate**：Take sample、Delete latest sample、Clear all samples、Save / Load samples、五种 OpenCV 求解器和 Save camera pose。切换到 Motion 调姿后返回，内存中的样本保留；退出应用前应保存 JSON 数据集。
- 图片区以「实时画面 / 标定板图 / 最近检测或样本」切换显示，不再堆叠多张大图。生成板图、完成检测/采样、点击样本编号时自动切换到对应图片。静态图标明来源与源时间戳；样本和检测图可切换原始 RGB 与角点/坐标轴叠加，导入数据集清除旧预览并选中首个样本，删除正在查看的样本后回到实时画面。
- 图片支持适应窗口、原始像素尺寸、缩放按钮、拖动平移、Ctrl/⌘＋滚轮缩放和双击复位。普通滚轮保留页面滚动；聚焦图片后可用 ＋/− 缩放、方向键平移、0/F 适应窗口、1 原始尺寸。图片来源或分辨率改变时复位；实时更新及同一截图的原图/叠加切换不重置用户缩放。
- 手眼标定步骤使用下划线页签，图片来源使用紧凑分段选择；普通按钮采用 13 px 字号和至少 32 px 高度。图片标题与缩放工具共用一行，窄窗口自动换行；适应、缩小、放大及大图开关采用 32 px 图标按钮，原始尺寸显示 `1:1`，保留中文可访问名称、悬停说明和键盘焦点。
- 「放大查看」打开模态大图，Esc 或关闭按钮退出并恢复焦点；离开标定页时关闭。实时 RGB 继续走 Bridge 二进制通道并按动画帧绘制，超过 1 秒未更新、断线或关闭接收后隐藏，不作为新鲜采样依据。「检测标定板」与「采样」仍分别获取原始分辨率图像，查看操作不触发采样或运动。
- 采样不移动机械臂，不切换 Controller，不依赖深度，不调用规划场景服务。Jetson 的限时只读采集进程取得 RGB、对应内参、图像时刻的 `base ← end-effector` 与 `camera body ← sensor` TF。六轴测量反馈需完整、连续停稳至少 300 ms（相邻反馈间隔不超过 100 ms）、速度绝对值不超过 0.02 rad/s、窗口位置变化不超过 0.002 rad；最近匹配关节帧与图像差值不超过 100 ms。图像及反馈检查 ROS 时间，Mac 到达时间不用于混配姿态。
- 图像时间允许相对 ROS 时钟超前最多 50 ms、帧龄最多 500 ms；CameraInfo 的帧、分辨率必须匹配，时间差最多 500 ms。只使用图像时刻 TF，不回退为 latest。缺失/过期/运动中/无足够角点/高重投影误差时拒绝样本。切换连接或离开页面使在途响应失效。
- ChArUco 至少 8 个角点，Grid 至少 12 个角点；目标覆盖率至少 1%，重投影 RMS ≤ 1.5 px、最大误差 ≤ 4 px。新姿态与已有有效样本至少相差 5°。相机内参、分辨率或固定光学变换变化后须新建数据集。
- 至少 8 个训练姿态，建议 12–20 个，围绕至少两个不同轴旋转。复验样本不参与拟合；至少 3 个新姿态，训练/复验最大固定标定板偏差都 ≤ 5 mm、2° 才显示「独立复验通过」。这是当前参考门槛，不是抓取精度保证；关节模型、板尺寸和机械松动仍会影响结果。
- JSON 数据集包含原始 RGB、内参、源时间戳、测量关节、机器人 TF、检测结果和样本用途；最大 200 个样本，内存数据达到 120 MiB 时需保存后新建。导入不信任旧求解结果，须重新求解。
- 外参导出同时标明 `parent ← optical sensor` 与换算后的 `parent ← camera body`（矩阵为行优先、平移单位米，含 XYZ/RPY）。Eye-in-hand 的 parent 为末端；Eye-to-hand 为基座。导出不修改 URDF、不发布替代 TF，不自动设置 `plane_verified=true`。使用新外参前仍应复验桌面/方块顶面。


## 原生页面窗口

多窗口功能提供页面工具条中的“拆出窗口 / 收回主窗口”。迁移复用同一个 WebView，保留标定输入、图片缩放和当前页面状态；关闭独立窗口会请求收回。采样、运动及采集操作进行中显示不能迁移的原因。Motor 页面真正隐藏后沿用离开页面的安全语义：停止连续发送、请求 DISABLE，重新显示保留编辑值并要求重新确认。

关闭主窗口只将其隐藏，独立窗口及共享连接继续存在；独立页面的“主窗口”按钮或 macOS Dock 图标可重新显示导航和连接入口。窗口布局保存至当前应用配置目录的 `window-layout-v1.json`，恢复页面拆出状态、正常窗口尺寸和位置，不保存运动授权或任务。显示器工作区变化时将普通窗口限制在可见工作区内；全屏、最大化和最小化不覆盖上次普通窗口尺寸。关闭应用仍须保存手眼样本等工作数据，窗口位置恢复不等于未保存样本恢复。

启动恢复独立窗口时，若原任务尚未确认结束或页面正在采样，先保留在主窗口，工具条显示等待原因；原独立窗口偏好和尺寸不会被临时位置覆盖。任务结束并通过正常迁移检查后自动恢复。若原生窗口操作失败，则停止自动重试，保留布局偏好，可用“拆出窗口”重试；回滚失败仍使用“恢复窗口”。这些入口不会清除任务占用或恢复运动授权。

未连接时把页面收回主窗口，可从连接表单的“返回已打开页面”继续查看。下拉框只列出已打开且加载完成的原生页面，复用原页面状态；选择仍在独立窗口中的页面会聚焦该窗口。“返回连接”隐藏嵌入页面并显示连接表单，不会自动连接机器人。

拆收中途失败会尝试恢复原父窗口、页面尺寸、显示状态和焦点。若恢复也失败，保留相关窗口并显示“恢复窗口”；再次恢复沿用当前窗口布局，不覆盖期间其他页面的拆收结果。恢复期间仍禁止移动正在采样或执行的页面。只有确认不承载页面的空窗口才会被清理；清理失败会明确提示，可以重试收回。失败的临时布局不覆盖已保存的正常布局。

开发分支的 Agent、USB、机械臂运行模式、Controller、Topics、时钟诊断、运动及抓取状态现由 Rust 会话统一查询。拆出多个窗口不增加这些远端定时查询；各窗口读取同一代状态，查询失败或过期不继续显示为就绪。手动刷新会同步其他窗口，控制器操作后的复查等旧请求结束后重新查询。任务所有权、共享编辑与重启恢复分别采用下文的原生协调和持久化机制。

模型与纹理原始字节由 Rust 在同一连接内共享缓存，最多 128 MiB / 512 项；多个页面同时请求同一 URI 会合并读取。桌面各页面不再各自长期保留一份原始字节缓存，已经创建的场景资源仍由对应页面管理。断线清空缓存，加载失败可重试；九窗口模拟源的有限时段内存测量见实现记录，不代表长期或复杂模型性能保证。

九窗口、拆收、图片交互、共享会话及故障恢复已在隔离应用验证，正式包已完成安装和离线启动核验。外接屏拔插按用户说明延期；隔离测试不等于实机运动验收。具体证据和环境边界见[多窗口实现记录](./multiwindow-implementation)。

点位/动作组和视觉抓取已在 Rust 登记任务所属窗口，提交待受理期间即禁止冲突执行与迁移；界面显示所属页面及等待受理、执行中、等待停止或停止未确认。窗口失联会请求取消，取消受理不会立即解锁。其他窗口不能替任务续租；DISABLE/取消之前排队的旧执行指令会失效。断线后不能仅凭空闲状态判断已停止；点位任务可在重连后按编号核验 Bridge 保留的完整终态，未知或已淘汰记录继续锁定。直接轨迹和有限 SSH 操作也已接入原生任务协调；外部活动只读观察按连接代次隔离，不自动接管；桌面重启恢复见下文，未知任务继续保留占用。

运动状态与任务续租现已分离：公共查询不会让失联窗口的任务继续运行，任务只在原生层确认所属窗口存活时续租。各窗口独立读取共享运动日志，原生历史上限 5000 项 / 2 MiB；读得太慢会明确提示历史截断。抓取面板拒绝用旧缓存覆盖新任务或已确认终态，夹爪反馈保留原始帧龄。

Monitor 的数值采集由 Rust 在预览帧合并前保存。打开并配置 Monitor 后，隐藏页面仍继续采集，停止历史读取与曲线绘制；再次显示会分批补回保留数据。历史限制为最新采样起 30 秒、8192 帧或 8 MiB，先到上限即淘汰；单帧上限 64 KiB，最多 64 个 Topic，图像与点云不进入数值历史。慢页面超过保留范围会显示截断提示并重建曲线，不把缺失区间伪装成完整采样。

Monitor 的暂停按钮同时暂停采集，保留已有曲线；恢复后重新配对运动误差数据，避免跨暂停区间混配。隐藏窗口与暂停采集是两个状态。Live/bag 切换清除旧时间域历史，断开连接清空原生历史。补回数据保持原始接收时刻，bag 沿用消息时间戳及 `/clock`，历史数据只进入图表，不更新机械臂控制反馈或运动新鲜度。历史不跨应用重启保存。

Monitor 仪表盘、曲线字段与布局现由 Rust 统一保存到当前应用数据目录的 `monitor-workspace.v2.json`。首次打开 Monitor 或 Topics 时导入旧本地配置，保留原数据作为迁移来源。Topics 添加曲线会同步到已打开的 Monitor；新配置保留仍存在的曲线采样点，其他页面不再覆盖 Monitor 配置。保存等待版本校验及原子写入完成，遇到并发修改会载入新版本并提示重试，写入失败保留当前内容；损坏文件不自动覆盖。配置最多 32 个仪表盘、每仪表盘 128 个面板、总计 2048 条曲线、512 KiB，原始图像和曲线采样点不写入配置文件。姿态库与动作组也已接入原生版本化保存，继续使用原有数据文件。Status 采集并保存姿态后，已打开的 Motion 会更新资源列表；正在编辑的草稿不会被覆盖。保存或删除时若该记录已被其他窗口修改，会保留草稿并提示重新载入。保存期间禁止重复提交，只有文件写入成功才关闭姿态表单；读写失败明确显示原因，损坏文件不会被清空。

## Docker 运行入口

新增 `npm run docker:bridge -- build|run`，支持 Humble 镜像、独立端口和 ROS domain、只读外部 overlay；无效端口/domain 在执行 Docker 前拒绝。启动、验证及桌面管理边界见 [Docker 运行说明](docker.md)。

连接高级配置可关闭“连接时启动 host Bridge”，直接连接已运行的 Docker Bridge；该模式拒绝 host 升级入口，旧配置默认保留 host 自动启动。

多窗口功能的离线“管理姿态库／管理动作组／手眼标定”入口会先把连接表单中的完整配置交给原生会话，再打开或聚焦原来的页面；不用先连接机器人。所有功能页接收同一配置，页面工具栏显示主机名。配置交接期间显示进度并禁止重复进入或连接，失败保留表单与旧页面。已有连接、原生未结束或未确认任务、本地采样和窗口迁移会阻止配置变化。“返回已打开页面”只返回已有内容，不把尚未应用的表单草稿写入页面。

姿态库与动作组按原有主机、用户名及 SSH 端口标识分别保留会话中的未保存草稿，切回后可继续编辑；姿态草稿同时保留原记录基线，其他窗口修改过的记录仍会触发保存冲突。切换不保留删除确认或运动授权。手眼样本继续保留其来源标识，换源后不能混入采样；窗口恢复不代表这些未保存草稿和样本会跨应用进程重启保存。

多窗口功能的布局偏好按页面保存：Motion 保存当前标签和 Controller 侧栏；Topics 保存面板、侧栏和分栏尺寸；主窗口保存导航与连接后跳转设置。其他页面启动或更新自身状态不会覆盖这些偏好。该归属不依赖页面是否聚焦，拆出与收回也不会更换写入者。存储不可用时保留当前内存中的设置。

多窗口功能中，手眼采集、检测、标定板生成及求解由原生层登记任务；任务运行时不能迁移该页面，主窗口及其他页面可查看处理/失败状态。页面退出或采集来源变更会取消工作，页面失联超过 5 秒时原生层终止任务，迟到结果不会加入新样本集。只读采集和本地求解不发送机械臂运动命令；文件对话框和导出继续使用原有忙状态。


Motor 连续发送已登记到原生任务：尚未受理时即阻止冲突运动和本页迁移。窗口退出或指令流中断后，Rust 请求 DISABLE，并持续显示“等待新鲜 HardwareStatus 确认输出关闭”；仅发布成功不解除占用。所有页面关闭后，原生反馈订阅仍保留至连接关闭。重连原机器人后核验新的 DISABLE 序列；切换机器人不会拿另一台的反馈解锁旧任务，也不会自动向另一台发送 DISABLE。重新显示 Motor 不会自动恢复连续发送，仍需安全确认。此功能尚未进行生产机械臂验收。


多窗口功能的重力辨识已加入原生任务登记：Start 待受理时即阻止冲突执行和页面迁移；Abort 表示请求取消，界面等待新的固件 HOLD/DISABLE 与六轴低速反馈确认。Action 返回、反馈 DONE 或单独 idle 不解除占用。窗口失联停止续租并取消；断线后按原编号查询保留终态。旧任务结果和晚到 ACK 不覆盖当前任务。该路径已完成隔离测试，实机运动仍需满足原有现场确认与反馈条件。

Position、动作组、视觉抓取和重力辨识与直接轨迹、Joint4 一样，绑定提交时的机器人连接配置。断线后只能连接原机器人、原 ROS 图及命令/反馈配置核验任务；另一配置即使返回相同任务编号的终态，也不会解除占用。切换本地隧道端口不影响恢复。已排队的任务查询、续租和取消在发送前再次核验身份，显式 DISABLE 仍可对当前连接发送。桌面进程重启还需读取对应持久化记录，具体规则见本文开头和后续恢复章节。

重力辨识期间点击 DISABLE 后，停止确认会要求固件实际进入 DISABLE；取消后编排器短暂发送的 HOLD 不能解除占用。Bridge 在 Action 返回后再次发送清零 DISABLE 并核对新序列反馈，普通 Abort 仍保持原有 HOLD 语义。


多窗口功能的单个及批量 Controller 切换已接入共享任务锁：仅控制模式 / Motion / Status 当前连接页面可以提交，预检前即阻止冲突运动及本页迁移。原生工作独立于页面存活，成功需要远端记录确认命令执行成功以及后续新鲜列表中所有目标 Controller 的名称、类型、目标状态一致。已成功命令遇到断线会等待原机器人同配置重连核验；SSH 错误或超时后按任务编号查询远端记录，恢复成功结果后再核验列表，不会自动重发切换。远端命令自身异常/超时、记录缺失或摘要不匹配继续保留“结果未确认”；明确在命令启动前拒绝才可报告失败并释放任务。整栈模式切换的原生生命周期与桌面重启恢复见下文；完整多窗口实机验收仍在进行。


Controller 切换期间发送 DISABLE，或确认支撑后选择“支撑并退出”的 disable-stop，会保留停止意图。先立即请求关闭输出，远端切换确认结束后再发送新的 DISABLE；只有对应新序列的新鲜 HardwareStatus 确认关闭输出才释放占用。之前的 DISABLE ACK、旧反馈和 Controller 目标状态成功不能代替这次确认。页面全部关闭后原生工作仍继续；未知远端结果继续持锁。普通停止中的 RETURN 回零流程没有改为立即 DISABLE，其他模式启停沿用下文的应用级工作与持久化恢复流程。


开发分支的直接 JTC 已接入任务协议和 ROS 适配器；trajectory_command ACK 仅表示发布，完成/取消需独立反馈生成带证据终态。Robot View 当前继续使用已有 MoveIt 执行流程。


多窗口手眼页的“前往 Motion 调整姿态”会聚焦已有 Motion 页面并明确切到 Robot View；首次使用则创建同一个 Motion 页面实例。手眼图片、样本和输入保留，不自动连接或开始运动。离线手眼入口使用公共页面容器，主窗口会随该导航切换，并可通过“已打开页面”返回手眼。导航若先于配置通知到达，会等匹配的配置就绪，不在另一机器人的编辑内容上应用。


多窗口 rosbag 状态由原生会话统一查询，Topics / Motion 的录制指示与 Monitor 回放状态共享更新，页面隐藏不停止查询。录制或回放操作后会重新核验，再更新各窗口；错误或过期显示“状态待确认”，不会误显示“开始录制/回放”，Monitor 仍可手动刷新。恢复新鲜结果后自动恢复按钮状态。本桌面发起的录制/回放具有原生运行期占用，并保存重启恢复记录。

rosbag 启动/停止操作已由原生后台接管。同类操作跨窗口串行，发起页在结果确认前不能拆出或收回；页面退出不会丢弃已提交操作。SSH 回复丢失后只查询远端记录，不自动重复启动或停止。只有对应命令的进程身份回执与同一机器人新鲜状态匹配，才确认操作。启动成功后仍保持所属页迁移占用，直到原进程组退出；进程 PID、路径相同但实例摘要不同不会被当作同一任务。结果未知时，连接页及各功能窗口显示原生 rosbag 操作提示。停止在 INT / TERM 后确认所有可识别的所属进程退出，否则保留身份记录并报告失败。进程记录支持后续状态查询；回放运行期与新运动、Controller/模式切换、采集入口互斥；DISABLE 和停止回放仍可用。未知或过期状态保留占用，并提供“尝试停止”入口；停止未确认时禁止重复提交。录制/回放的桌面重启恢复见下文；其他任务类型的重启恢复见相应章节；外部活动仅观察当前连接，不自动接管。旧版启动且缺少新身份记录的活动 bag 必须由原启动方式停止，应用不会仅凭 PID 接管。启动后身份落盘失败时保留待恢复标记，阻止重复启动；停止要求远端 Python / 内核支持 pidfd。

桌面提交 bag 操作前，先将机器人配置、原页面、只读查询编号/摘要和已知进程身份写入应用配置目录的 `bag-recovery-v1.json`。恢复记录不包含命令正文、密码或私钥内容；权限为 0600，最多两个资源记录、48 KiB。重启先恢复占用，再开放页面；未连接时显示待恢复，只有连接原机器人配置后才查询原任务，不自动连接、不重发启动/停止。已验证运行中的实例直接恢复共享状态监控，原实例的新鲜退出证据与恢复记录清理都成功后才释放。写盘失败拒绝新提交；退出已确认但清理失败则保留占用并重试。缺失、过期、另一机器人、同路径替换进程都不能完成恢复。

恢复文件损坏或版本不受支持时保留原文件，显示错误并阻止新增运动、在线采样、Controller 切换及 bag 启动；离线图片、DISABLE、显式停止入口仍可用。损坏状态下的显式停止只在当前进程内核验，不覆盖损坏文件，也不会解除恢复错误门禁；需保留文件并核查原机器人实际状态后修复记录。远端任务记录未知时保持待确认，不因桌面重启或重复连接自动判定结束。此段说明 rosbag 恢复；Episode 和有限控制恢复见下文，尚非所有任务均支持跨桌面进程恢复。


Status / Motion 的整栈启动、模式切换、相机重启、MoveIt 启动及退出操作已纳入原生共享控制任务。操作期间，其他窗口的冲突运动和发起页面的拆收被拒绝；页面退出不会丢弃已提交步骤。启动进度写入远端完成记录，各窗口可看到所属页面、运行或待确认状态。SSH 回复丢失时仅查询记录，不重复启动。远端成功后还要核验原机器人新鲜模式状态及相应 Controller；远端的 ready 标记不会提前结束本地核验。

切换期间的显式 DISABLE 继续优先发送，并在远端步骤结束后再次关闭输出、等待新的硬件反馈。已支撑退出若遇到当前控制切换，会先登记关闭输出请求，明确提示环境清理尚未执行；共享任务结束后可重试退出。普通回零退出不抢占正在进行的运动，保持原 safe_stop 的 RETURN → DISABLE 流程。远端异常或超时仍保留未知占用，不把未知结果当作完成；应用进程重启后的恢复通过下文的有限控制恢复记录核验。

多窗口功能中的 Episode 变更现在由 Rust 应用级工作执行。实际数据采集页面和当前连接必须匹配，提交前登记迁移占用，保留既有就绪检查和丢弃确认。已提交的启动、保存、丢弃、完成数据集不随页面关闭而取消；25 秒未确认时页面收到“仍在核验”，各窗口继续显示任务。SSH 回复丢失只查询原操作记录，不重发。成功需要远端回执和原连接的新鲜状态匹配，包括数据集、PID/启动身份、计数及动作目标状态；未知结果保留占用。

开始 Episode 成功后仍保留采集页迁移锁；同一连接可以继续保存或丢弃，完成后才释放。任务不会占用全局机械臂运动槽，因此已有遥操作可继续录制。页面重新附着可以接续同一连接的保存流程，另一连接不能接管。桌面重启后的恢复通过下述持久化记录核验；不自动接管外部启动或外部改变状态的整个录制生命周期，不能以普通 idle 状态消除未确认操作。


连接期间的共享 bag / Episode 状态现在参与原生操作准入，即使任务并非本桌面启动：回放非空闲或状态未知时拒绝新增运动、Controller/模式切换和在线采样；回放启动还要求录制与 Episode 均空闲。Episode 有待保存帧、正在启动或收尾也算忙碌；采集中的示教运动仍允许。缺失、过期、失败或格式不一致的状态不能证明空闲。运动的排队发送与 SSH 变更提交前再次检查，停止、DISABLE 和离线图片计算保留。Monitor、数据采集及录制入口对应页面在关联活动非空闲或状态未知时拒绝迁移，显示具体原因。

这项检查复用既有共享轮询，不额外查询 SSH，也不接管或自动停止外部进程。bag 探测范围是现有私有身份记录管理的实例；任意终端手工启动且未登记的 `ros2 bag play` 不在此探测范围内。采集器可由现有 status 服务报告未托管的外部 Episode。观察不是远端跨客户端的互斥锁：其他客户端可在查询后启动任务，当前桌面也不保证即时发现或自动中止已执行运动。断线后离线页面仍可编辑；本桌面已持有的未确认任务继续阻止迁移，外部活动跨连接持久归属尚未完成。

直接 JTC 的消息时间戳改为零，由控制器消费时开始计时，避免网络或调度延迟缩短首段插值时间。完成和取消释放都额外核验 JTC desired.time_from_start 与本次发布时间，旧轨迹的相同静止末点不能释放新任务。隔离回归包括真实 JTC 2.53.1 与 GenericSystem 的延迟对比、Core 中旧轨迹/缺失时间/延迟消费负例，以及真实 Bridge 发布零时间戳的 ROS 适配测试。实机起点变化、硬件限幅和最坏调度延迟仍不由这组测试证明。


### Episode 桌面重启恢复

变更提交前保存 `collection-recovery-v1.json`（版本 1、一个在途任务/运行检查点、最多 24 KiB、0600）。保存原 Profile、动作、只读远端查询票据与原 Episode 回执；不保存命令正文或自动重发采样、保存、丢弃、结束。应用先恢复迁移与回放互斥占用，再初始化页面；显式连接原机器人后才查询原记录。已确认采集中的检查点，须以同一受管理进程、数据集和保存计数的新鲜状态恢复“采集中”；断线、过期、身份或计数变化均保持待确认。保存回执要求同实例且保存数恰好增加一，丢弃要求计数不变。先保存/丢弃，再结束数据集。

采集器身份现在包含 Linux boot ID、PID 与启动计数的 SHA-256；结束使用核验后的 pidfd 发送 SIGINT，只指向采集器进程，不发进程组信号，不退回数字 PID kill，不升级强制终止。旧版仅保存启动计数的元数据无法证明跨重启身份，不由新版本接管；请使用原启动终端保存并完成旧采集器，再用新版本启动。外部采集器缺少受管理实例身份，当前会话仍可显式操作，但重启后不自动恢复其 Episode 操作权。

持久化失败阻止提交；终态清理失败保留占用并重试。恢复文件损坏/版本不符时保留原文件、显示“任务恢复异常”，禁止新运动和新采集；DISABLE 及满足原有新鲜度/状态条件的显式保存、丢弃、收尾仍可用。损坏状态下这些收尾只在当前进程核验，不覆盖损坏文件，不解除全局恢复错误。回执没有独立的 Episode UUID；外部客户端在同一进程中丢弃后重新开始且保存计数不变的变化不由此机制唯一识别，跨客户端全生命周期协调仍待完成。

恢复文件写盘不持有共享连接锁；采集完成在写盘后再次核对连接代次。写盘过程中断线仍保留当前占用，等待原连接复验；磁盘等待不阻塞 DISABLE 的共享发送通道。


### Controller / 控制环境的桌面重启恢复

开发分支在提交单个/批量 Controller 切换或整栈模式操作前，保存 `finite-control-recovery-v1.json`：版本 1、至多一个任务、24 KiB、0600，包含原 Profile、原页面和一次性远端查询票据，不包含执行命令。提交前写盘失败则不发送；远端终态已核验后，仍保留新运动/回放及原页面迁移占用，直到恢复记录持久化清理成功。清理失败可重试；DISABLE 不等待磁盘写入。

桌面重启先恢复占用，再创建页面。仅在显式连接原机器人完整配置后查询原操作，既不自动连接，也不重发模式切换、回零或控制器激活。远端已成功或已明确拒绝执行，都只证明该原操作结束；重启不恢复运动授权，需要现场支撑确认后显式 DISABLE，再由完成之后的新序列及新鲜 HardwareStatus 证明输出关闭。此前的 DISABLE ACK、旧反馈、另一机器人和普通目标状态相符均不能释放恢复任务。远端记录丢失或执行结果 uncertain 继续保留占用，单有输出关闭也不能证明远端操作以后不会继续执行。

当前桌面未重启的正常操作仍采用既有“远端成功＋新鲜目标状态”完成条件。若操作已终态但磁盘清理尚未完成，Status 的“支撑并退出”仍可发送 DISABLE，界面只报告受理，不把 ACK 当作输出关闭；环境清理尚未执行，待任务收尾后重试。恢复文件损坏/版本不符时显示“任务恢复异常”，保留文件并禁止新运动；DISABLE 和离线标定板/样本计算仍可用。其他运动任务使用 Motor 或 Bridge 租约任务恢复记录；外部活动不自动取得本桌面任务归属。

### 主窗口渲染进程恢复

主窗口页面重载后先读取原生共享会话。如果原生连接仍在，只恢复当前页面的消费者、连接状态和公共订阅，不重复建立 SSH 隧道，不重放运动指令或恢复运动授权。恢复期间禁用新连接；查询失败或恢复期间连接代次/配置发生变化时显示“重试恢复共享会话”，不自动断开其他窗口。若整个桌面应用已退出，新进程仍保持未连接，需手动连接。

正常退出应用时会显式关闭本应用持有的共享连接及 SSH 隧道，防止残留转发占用端口；不会按进程名清理其他 SSH 或 ROS 进程。退出不构成运动已停止的证明，未确认任务的恢复记录继续保留。

### 控制模式与 Controller Manager

- 左侧 **控制模式** 页面集中 Manager 生命周期、模式预设和 Controller 管理；操作历史集中在全局 Terminal。Status 保留状态总览及跳转；Motion / Topics 只读查看 Controller，管理按钮跳到此页。
- 「启动并加载全部」使用当前 ROS overlay 的 `microros_stm32h723_bridge/config/arm_controllers.yaml` 和机器人 xacro。新 Manager 的硬件组件保持 inactive；从 Manager 实际声明的 `*.type` 参数枚举全部 Controller，依次 load、configure 到 inactive，包括 broadcaster，不自动 activate。连接已有 Manager 不重放启动或激活操作；「补加载 / 重试未配置项」保留已有 active / inactive，只处理 unloaded / unconfigured。
- 列表区分未加载、未配置、已加载未激活、运行中和未知，展示类型及实际所需命令接口。加载失败保留成功项、上次失败原因和操作历史，可补加载重试。管理元数据通过固定的原生 SSH 只读程序查询；连接代变化后丢弃旧响应，过期快照禁止操作。Bridge 的运动健康查询链路不变。
- 支持逐个或批量启用、停用。批量目标之间争用同一命令接口时拒绝；与运行中 Controller 冲突时，在确认框明确列出需要停用的对象。确认后远端重新比对实际快照，严格切换，并再次读回目标状态。手动组合不凭 active 集合声明完整模式就绪。
- 启用命令 Controller 可能激活硬件并产生保持力矩。保留现场确认、共享任务互斥、拖动示教退出要求及整组 MIT / V2 租约释放校验。停用 Controller 后仍已加载，**不等同电机 DISABLE**。模式预设沿用原有整栈启动、安全退出与核验流程。
- 仅能停止本应用创建并有精确 PID/启动身份记录的 Manager。要求所有 Controller 非 active、无冲突任务、三帧推进的无故障 DISABLE；V2 环境还要求实际关闭输出的读回。使用 Linux pidfd 对精确进程发信号；停止进程不替代电机停止。
- 管理操作由原生会话托管，先持久化任务票据，再单次提交。断线或 UI 消失不会重发；结果未知保留任务占用，重启沿用控制恢复流程。确认框保留在操作页面；进度及失败原因写入全局 Terminal 的 `Controller` / `Task` 来源，页签切换和断线不清除；实际服务结果和新查询一致才显示完成。

- Manager 查询与管理支持主窗口中的嵌入页面及拆出的控制模式窗口。模式预设启动与单独激活 Controller 都先核验新鲜 MIT / V2 控制权读回；`lease_id=0` 但 `owner_source_id` 非零仍拒绝启动，提示在 Motor 恢复整组 MIT。预检拒绝不会提交远端变更或留下新任务占用。停止不受该启动门禁阻挡。
- 模式启动失败摘要保留首条 ERROR 及有界末尾日志，避免后续 shutdown 错误掩盖硬件激活失败；远端执行结果未确认时仍保留任务，不自动重试。
- 管理按钮同步原生共享任务占用；任务未结束或状态查询失败时禁止管理变更，保留只读刷新。阻塞原因在 Manager 下方集中显示，控制模式不重复展开同一原因；原生任务详情可在 Terminal 标题栏查看。

- Manager 后台同步在上一查询完成后至少等待 5 秒，和手动“刷新”分开显示；手动刷新可等待正在进行的同一查询，不重复发起。新鲜快照仍可用于打开确认框，超过既有 10 秒有效期则继续禁用变更。按钮分别解释任务占用、Manager 未启动、非本应用进程及仍有 active Controller 等原因。
- 对固定模式启动留下的失败事务，恢复查询要求原编号/摘要一致、明确的非零正常退出（不是超时或未知记录），并核验原启动 PID 文件及同 ROS 域的 Manager、启动器、spawner、控制服务客户端等均不在运行。进程或环境不可读时保留占用。核验通过仅允许进入关闭输出确认阶段，不把失败改成成功，不重发启动；仍需在“模式预设 → 直接关闭输出”确认现场支撑，取得这次请求之后的新鲜 DISABLE 回执与固件反馈，才清理原生恢复记录。


### Manager URDF 发布

启动并加载全部（或为已运行 Manager 补齐加载）会确保同一 URDF 的 `robot_state_publisher` 可用，等待 `/robot_description` 的可靠、瞬态本地消息后继续。已有兼容发布者会复用；重复发布、模型不一致、已有进程却未发布时明确报错，不重复拉起。默认硬件和 Controller 仍为 inactive，不使能电机。停止本应用管理的 Manager 后，仅停止本应用记录且进程身份匹配的配套发布者；外部发布者保留。

### Motor 断线后的停止核验

断线后锁定模式编辑并撤销安全确认。重连后仅在源时间戳推进的新鲜 V2 反馈证明 `disabled_verified=true`、DISABLE、使能掩码和租约均为 0、无控制占用、无切换及故障时解除停止等待；重复、过期或未核验反馈不能解锁。不会自动重发指令或恢复运动。固件显示 DISABLE 但尚无关闭输出证明时，页面说明原因，并提示现场支撑核对后使用始终可用的“停止并 DISABLE”重新核验。

### 控制状态核验与任务恢复

控制模式页的 Manager 卡片与模式预设共用同一份 SSH Manager 快照。模式只有在新鲜 Manager 与 Bridge 的 active Controller 集合一致时才确认；Manager 不可用却仍收到 Bridge 的可用列表、active 集合不一致或 Manager 名称不一致时显示“状态不一致 · 待核验”，禁止新管理变更与模式启动。Manager 或 Bridge 数据过期时等待重新核验，过期统计显示“—”。查询 Manager 不会清除原生任务占用。

共享任务的提交、运行、停止确认、结果待核验均阻止启动新模式；已打开的示教确认框也同步门禁。原任务详情展示原生状态说明，停止或结果待核验时，“查看任务与关闭输出”进入模式预设，直接关闭输出区域自动展开，继续沿用现场支撑确认。恢复顺序仍为远端操作结束证据、新的 DISABLE 反馈、持久化清理后释放占用；Manager 不在线或观察到输出关闭不能替代这些证据。


## 全局 Terminal

- 主窗口在导航右侧最底部提供一个 Terminal；嵌入页面不重复显示，拆出窗口有自己的面板。连接页、离线页面同样可查看。默认展开 240 px，收起为 36 px；支持拖动/键盘调整和最大化，面板高度与展开偏好按窗口保存。
- 汇合连接、系统、Bridge 部署、Controller/控制模式、Motion/MoveIt、Motor、采集器、手眼标定、重力辨识、Topics、URDF、图像和窗口操作诊断。原生任务、ROS 文件和采集器尾部日志在页面隐藏时继续采集；页面自己的输入校验和操作诊断在发生时写入。高速遥测、图片和 JointState 不逐帧写入。
- 默认显示当前连接会话的 INFO 及以上；支持会话、来源、级别、任务和关键词筛选。时间按桌面接收顺序显示，列表虚拟化；长行/多行日志点击查看并复制完整保留记录。来源无任务 ID 时不虚构关联。
- “跟随最新”只控制滚动；向上滚动暂停跟随，采集继续。“清屏”只隐藏当前窗口已接收记录；“恢复清屏”可恢复尚未淘汰的记录，不删除归档、不改变任务状态。未读错误提供入口，同一任务的新错误最多自动展开一次，读取历史不自动弹开。
- 主窗口和独立窗口共享原生历史，各自有游标和筛选。断线不删除历史；远端读请求使用发起时会话，运动日志和任务记录按 epoch/任务绑定原会话。新连接默认不混入旧连接输出；切到“全部会话”可查旧记录。
- 共享控制任务在 Terminal 标题栏保留紧凑状态，点击可查看原生控制、手眼、rosbag 和采集任务及已有操作。控制页保留当前模式、禁用原因、现场确认、停止和 DISABLE 入口。日志文字、清屏、导出或隐藏面板均不能释放任务占用，也不能证明电机输出已关闭。
- 原生内存历史与每个窗口展示各最多 20,000 条 / 20 MiB；单记录正文最多 16 KiB，前端输入最多 16,000 字符，超过会截断。原生归档队列另限 20,000 条 / 20 MiB；写盘失败、队列溢出或历史窗口淘汰会明确提示。
- 归档位于 macOS `~/Library/Logs/dev.easydebug.desktop/terminal/`，JSONL 文件权限 0600，按分钟分文件，后续写入时清理到总量不超过 100 MiB 且不超过 7 天。关闭应用前最后约 1 秒未刷盘内容可能丢失；归档不用于任务恢复，重启后不会自动加载进列表。复制和导出使用保留记录；较早记录可在归档中查找。
- “导出筛选”使用当前筛选和清屏边界；“导出会话”导出当前连接仍保留的所有记录。远端文件来源可另行“下载源日志”，仅对当前连接会话可用，沿用来源白名单、路径边界和 32 MiB 上限。导出失败只显示错误，不影响控制。
- 原生写入移除 ANSI/终端控制字符，并遮盖常见 password/token/secret/api_key、Authorization/Bearer 及整条含私钥标记的记录；这属于常见格式脱敏，不保证识别任意自定义密钥。源日志下载保留原始内容。Terminal 不执行命令、不解析日志内链接为操作。

验证入口：`src/Terminal.test.tsx`、`src/terminalLogLogic.test.ts`、`src-tauri/src/terminal.rs`、`src-tauri/tests/test_control_logs.py`，以及各模块原有控制与故障测试。


### 控制页提示与统一入口

- Manager 卡片内显示紧凑的同步状态，当前模式只显示实际状态及必要的回零/重建提示；不再重复显示正常状态的解释段落。
- Manager 下方统一提供「操作说明」和「查看日志」。说明默认收起，集中解释加载/停用、模式切换及退出语义；查看日志打开本窗口对应 Terminal 的当前会话、全部来源，重置旧筛选和清屏条件，涵盖 Controller 操作、共享任务与 ROS 输出。两个管理页签共用这一入口。
- 操作区保留停止/直接关闭输出、就近简短风险提示及现场确认。阻塞原因、失败信息继续可见；正在执行或失败的流程显示实际步骤，已完成步骤不长期占据操作区，完成结果保留在 Terminal 历史。收起说明或查看日志不改变控制权限和任务状态。
- Terminal 的筛选、跟随与导出控件按可用宽度换行，复选框使用独立固定尺寸；窄窗口工具栏可滚动，避免文字与按钮重叠。


### 全页面操作日志统一

- 所有页面的控制/操作日志只在底部 Terminal 输出；Motion 的普通、紧凑、Robot View 和独立窗口均使用这一入口，没有可切回旧日志面板的布局分支。Motion 本地保留可折叠的结构化执行报告（关键帧、数值误差和判定结果），其尺寸与展开状态独立于 Terminal。
- 数据采集、手眼、重力辨识、Motor、动作组编辑和 Monitor 的操作结果在页面仅显示简短状态与「查看操作日志」，原始消息、异常和多行输出进入对应来源。控制页运行/失败流程保留步骤和简短失败状态；连接失败就近保留有界的当前原因，完整输出在 Terminal。
- 补齐姿态编辑/保存、动作组编辑、Monitor 预设导入/导出、视觉抓取、RGBD/模型错误、窗口操作及重力辨识文字反馈。浏览器模式直接收到的 Motion 远端日志也进入 Terminal；原生模式由应用级采集器记录，页面不重复转载远端行。
- 输入校验、实时硬件/控制状态、故障与安全确认、结构化标定结果和 Topic 原始数据继续在业务位置显示；它们不构成另一个控制日志窗口。日志显示与清屏均不授予控制权，也不代表任务完成。
- 逐页数据路径、回归测试及实际验证范围见[Terminal 全页面检查表](./terminal-output-audit)。

### 顶部错误通知

- 新发生的操作失败以顶部非模态浮层提示，显示后 3 秒自动关闭；可手动关闭或「查看日志」。同一事务只提示一次，连续相同错误轮询不延长计时；重新操作使用新的通知标识。同窗最多 3 条，超出时较早提示退出，历史仍在 Terminal。
- 错误先写入 Terminal，浮层引用同一记录。查看日志会展开本窗口 Terminal，清除旧搜索/清屏条件，切换至该记录的会话和任务上下文，并展开原始记录；不会重新写一份错误日志。读取历史、页面初始错误状态和普通原始日志不弹窗。
- macOS 使用归属于业务页面当前窗口的非聚焦通知子窗口，位于内容区顶部居中；不改变页面边界、可见性或控制租约，不抢输入焦点。嵌入页面的通知归主窗口，拆出页面归独立窗口；关闭/隐藏父窗口或移动页面后旧提示退出。全局连接和新硬件故障仅由主窗口提示。
- Motor 删除重复的固件范围/反馈汇总及常驻事务错误详情。范围、模式读回、失败快照仍保留在 Terminal；界面反馈快照标明记录时间，不能当作固件失败瞬间读数。关节卡片、参数校验、当前阻塞原因、安全确认、停止和 DISABLE 不受浮层关闭影响。

### 紧凑操作布局

通用操作按钮采用 28px 最小高度，保留文字标签、键盘焦点与危险操作颜色。控制模式页面压缩 Manager 摘要、页签及模式卡片间距；宽窗口中模式选择与启动并排，窄内容区改为两列模式与独立启动行。停止操作保留现场说明与确认，状态卡片按可用宽度排列。布局调整不改变控制门禁或命令行为。

### 控制页提示位置

控制模式页的详细失败原因、Controller 加载错误和启动流程消息统一写入底部 Terminal，页面正文不再放置日志入口或过程输出。顶部固定提示栏集中显示当前硬件警告、阻塞原因、进行阶段及失败摘要；相同提示去重，状态解除后移除。实时状态与参数仍在卡片中，危险操作的现场说明及确认保留在操作处。
