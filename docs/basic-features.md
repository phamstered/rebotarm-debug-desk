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
- 页面导航只保留在左侧 Navigation，**Status** 为第一项（只读状态总览卡片网格），其后为 Topics、Monitor、数据采集、Motor 和 Calibration；Robot View / Topic Graph / 位置 作为 Topics 中心面板标题栏内的局部 Tab。数值曲线在 Monitor 导航页。顶部工具栏不再重复品牌或导航。
- **Status** 页复用现有连接态并增强详情：SSH/隧道、Bridge WS + hello、micro-ROS Agent（`check_micro_ros_agent` / `restart_micro_ros_agent`）、HardwareStatus（成功时「无故障 · mode」、失败时 fault 描述）、JointState 冒烟与 Hz、`check_ros_controllers`、ROS_DOMAIN_ID；USB CDC 经 SSH `probe_jetson_usb`（MCU `0483:5740`、串口、RealSense `8086:*`）仅「刷新检测」；Teleop / Trajectory / RealSense 卡片经 `probe_arm_mode` / `start_arm_mode` 一键拉起（SSH BatchMode，优先从当前 ROS setup 目录定位工作区，可用 `LEADER_FOLLOWER_WS` 覆盖，并兼容旧 `leader_follower` 目录；启动前读取新鲜 HardwareStatus，拒绝未恢复的锁存故障；停止旧 Teleop / Trajectory 前调用现有硬件 safe_stop（按当前增益执行 RETURN → DISABLE），等待 STM32 DISABLE 确认后仅通知启动脚本清理，不发送孤立 HOLD；安全停止被拒绝或确认超时时保留命令进程并报错；SSH 侧互斥保护并等待脚本完整自检与非零命令确认后才报告启动成功，超时保留 PID 供「停止」处理）。回零停不下来时可选择「解除输出并停止」，确认现场支撑后由控制器 `~/disable` 服务持续发送零输出 DISABLE，收到 STM32 回执后才停进程（需要支持该服务的 ROS 控制插件）；服务缺失或回执失败时不会改用外部发布者或强杀。一键 Teleop 执行 `scripts/start_arm_teleop.sh --position-controller=teleop --gravity=true --gripper=true --clean=true --start-leader=true`。**VLA** 卡片经 `switch_ros_controllers` 启停 `vla_position_controller`（互斥 `arm_teleop_controller` / `arm_trajectory_controller`，保持 `gravity_compensation_controller`）；启动前 HOLD 失败则中止；若 Teleop/Trajectory 持有 ros2_control 则跳过 stop，仅切换控制器，归属不明则拒绝；成功后校验 controller active（及可用时的 TRACK）；`fault_code=11` 禁用启动类按钮。可选采样 `/vla/joint_chunk`（`VlaJointChunk`）。Monitor 提供 `+VLA` 模板（`positions[0..5]`）。完整用法见 [VLA 使用指南](./vla)。无一键升级全部或自动刷写 STM32。
- Status 分为「连接 / 硬件健康 / 控制模式 / 传感器」四个 Tab；默认打开连接。Tab 按卡片状态聚合，异常优先于注意、未知、正常、空闲，隐藏分区仍持续更新汇总；支持左右方向键、Home/End。Fault 芯片会自动打开硬件 Tab 并高亮 Hardware，HOLD / 故障提示在所有 Tab 保留。
- 控制模式 Tab 保留互斥模式条与停止/解除输出确认，并提供实时日志：默认按当前模式选 Teleop、Trajectory 或 ROS 控制器/VLA，也可选择 RealSense。通过 Tauri `read_control_log` 走只读 SSH，每轮完成后间隔 1 秒刷新，仅在控制 Tab 和窗口可见、SSH 可用时工作；搜索不区分大小写并移除终端控制字符。关闭「跟随最新」或向上滚动后保留阅读位置，刷新不覆盖搜索内容。

Robot View 左臂腕部点云默认使用 `/cameras/left_arm/wrist/` 下的彩色图像、对齐深度和 CameraInfo；一键 RealSense 启动 ROS 栈的 `left_wrist_camera.launch.py`，启用深度对齐和时间同步，并把 `camera_link` 接到相机的 `left_arm/wrist_link`。Bridge 对三个流分别选择兼容的可靠性，均以 `VOLATILE` 订阅，兼容 RealSense 图像与 CameraInfo 不同的 durability；点云帧最多等待 150 毫秒获取采集时刻 TF。若 500 毫秒内有成功帧，短暂 TF 失败不会中断上一帧；持续失败会隐藏过期点云并显示错误，避免与实时 URDF 姿态错位。点云开关、着色、点大小和近远距离控件可交互；尚未收到完整 RGBD 帧时显示等待提示。修改过的自定义 Topic 配置不会被默认迁移覆盖。启动文件需先安装到 Jetson 的 `rebotarm_gazebo` 包。
- 日志窗口展示末尾 128 KiB / 2000 行；「下载完整日志」通过保存对话框保存未经过搜索过滤的 `.log` 文件（最大 32 MiB，超过时明确拒绝）。来源仅限 `$HOME/.cache/robot-console/arm-{teleop,trajectory,realsense}.log` 和 `$HOME/.ros/log/ros2_control_node_*.log` 中最新文件；VLA 日志随宿主控制器进程记录。缺失日志显示等待，读取/下载失败显示原因；SSH 操作有 10 秒远端 / 15 秒本机超时，切换来源、隐藏或断开后忽略旧响应。此功能不启停 ROS 或机械臂。
- 已连接工具条与 Navigation 标题共享顶部行高度，两侧底部分隔线始终对齐；窄窗口时状态灯换到下一行并同步撑高标题区。导航列表与主页面内容在标题区下方独立滚动，不与连接控件重叠。
- 已连接顶部工具条提供「断开并重连…」、连接配置、设置、压缩状态灯（含 ROS 就绪 / Bridge 版本徽章 / Fault 芯片 / Domain 提示）、连接名、隧道端口、Agent 与断开；Topics 页工具栏保留全部刷新、实时显示暂停/恢复、rosbag 录制、诊断快照与重置布局。
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

- Robot View 同级提供 Topic Graph 和「位置」Tab（DataGraph 已迁至 Monitor 导航页）。Topic Graph 展示 ROS Node、Topic，以及 Publisher/Subscriber 的有向连接关系，视觉语义与 `rqt_graph` 一致。「位置」保存当前连接（SSH 主机、用户、端口）下的六个臂关节点位，HOME 固定为 `builtin:home`，界面和保存文件都不能删除、改名或覆盖它；数值尚未从 Jetson SRDF 同步时显示「待同步」。每个点位左侧按 URDF 关节链画一张姿态缩略图；没有实机 `robot_description` 时用内置运动学模型。「保存当前姿态」读取 1 秒内完整的 joint1–joint6，优先配置的 JointState，否则用 `/joint_states`。重力补偿下手把手臂拖到目标位置后可以保存，只记录关节角，不下发运动。未连接时连接页的「管理位置」打开同一份数据。自定义点可以新增、编辑和删除。
- 点位执行使用 Jetson MoveIt2：连接后显式激活 `arm_trajectory_controller`，运行控制栈的 `ros2 launch rebotarm_moveit_config real_move_group.launch.py`，勾选会话内安全确认后点击点位卡片。保存、编辑和删除不会触发运动。HOME 来自当前 `/move_group` 的 SRDF `arm/home`，未同步时不可执行，不以全零替代。
- MoveIt `/move_action` 负责碰撞规划、时间参数化及通过配置好的 `arm_trajectory_controller/follow_joint_trajectory` 执行完整轨迹。只允许 `arm` 六关节；不控制夹爪，不自动切换控制器。速度与加速度缩放固定为 0.2；服务端需禁用自动控制器管理、配置起点容差 ≤0.02 rad、速度 ≤1 rad/s 与加速度 ≤2 rad/s²（真实入口采用 0.5/0.5、起点 0.01）。未知/缺少 MoveIt 编译支持时禁用执行并提示原因。
- Bridge 在规划前及执行期间校验控制器 active、三类反馈 <1 秒、TRACK/故障/使能掩码、反馈一致性、完整有限关节值和模型限位。跨连接只允许一个点位运动，`command_id` 去重；规划/执行超过 180 秒、故障、反馈丢失、配置变化、连接断开或会话心跳超过 5 秒会请求取消。手动 MIT（DISABLE 除外）、旧拖拽轨迹及重力辨识不能覆盖正在运行的点位运动。
- 界面显示校验、规划、执行、到位检查和取消阶段；只有 MoveIt Action 成功且新鲜六关节误差 ≤0.02 rad、速度 ≤0.03 rad/s 持续 200 ms 才显示到达。取消 ACK 不代表停止；确认新鲜反馈停稳后才显示取消完成，5 秒未确认则显示“停止未确认”并保持锁定。断线不会自动重发运动。
- 碰撞检查覆盖 URDF 自碰撞与 MoveIt Planning Scene 中的已知障碍物。Robot View 显示的 RGBD 点云目前不自动写入 Planning Scene，不能据此声称已检查现场所有物体。
- Robot View 左上角有「运动控制」面板。还没有执行结果时显示「无运动」。误差由下发关节或 TCP 目标与停稳反馈计算：关节为弧度差，TCP 位置为毫米、姿态为角度。切回 Robot View 后该面板持续展示点位运动状态，点位运动期间锁定 TCP 拖拽；拖拽本身仍按原有本地 IK 松手下发，其误差结果尚未写入该面板。
- Topic Graph 在打开时立即加载，默认每 30 秒自动刷新，也可点击“刷新 Graph”手动刷新；图变化不影响现有 Topic 数据订阅。
- Graph 使用确定性的力导向布局：ROS Node 为圆角矩形、Topic 为椭圆，使用与界面一致的蓝青/青绿色，连线保留发布/订阅方向；图形大小反映连接数。节点之间有斥力、连接有引力，并进行碰撞消除；初始布局以可用尺寸为参考，但节点坐标不受初始布局矩形限制。默认隐藏 Bridge 节点及其私有 Topic，可用“显示 Bridge”开关恢复；共享机器人数据 Topic 保留。
- 无限画布初始以 100% 缩放居中节点，支持滚轮/按钮缩放、空白处拖拽平移；可将节点拖到初始布局之外，刷新后仍保留手动位置（节点仍存在时）。Fit 根据所有节点的实际位置缩放取景，Reset 以 100% 缩放将现有节点居中；选中节点后仍可自由平移，松手不会重新居中。节点标签保留 Topic 名称中的 `/`，最多显示原名称前 20 个字符，超出时用省略号提示，完整名称可从悬停提示和辅助标签读取。连接线上用粒子动画示意数据流向与快慢（当前为占位流速：publish 快于 subscribe，尚未接真实 Hz）。
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

- Robot View 从 URDF 解析关节链并定位 TCP（夹爪）link：连接配置里的 `tcpLink` 优先；留空时优先选择 tool0/tcp/ee_link 等工具坐标系，其次选择 gripper/flange 等稳定 link，可以是带手指子 link 的夹爪基座，不因手指层级更深就选到 finger/jaw。无命名工具 link 时回退到最深叶子 link。视图显示实际使用的 link；rebotarm 默认选择 `gripper_link`。
- 仅当 `/controller_manager` 存在 active 的轨迹控制器时开放拖拽；识别规则为类型 `joint_trajectory_controller/JointTrajectoryController` 优先、名称含 traj 次之。ROS Control 列表会用“轨迹”标记对应 Controller，Robot View 右上角显示其名称和 `/…/joint_trajectory` Topic。
- 拖拽手柄跟随 TCP link 的世界位姿，并保持屏幕上的恒定尺寸；按住后鼠标移动映射到过 TCP 的正交平面（相机正对平面），拖拽期间暂停轨道相机；Esc 取消并把模型恢复到实时反馈位姿。
- 拖拽过程按帧求位置逆解：有限差分雅可比 + 自适应阻尼最小二乘，关节限位钳制，单次下降卡住时做确定性随机重启。仅做位置求解，TCP 姿态保持不变；只有残差不超过 5 mm 才允许下发，下发成功时会把实际残差一并展示，避免暗示夹爪精确落在目标点上。
- 自动订阅 active 控制器的 `controller_state`（旧版本兼容 `state`）读取实际 `joint_names`，按该列表与顺序生成轨迹，不再把 JointState 中额外的手指关节发给只控制 joint1–6 的机械臂控制器。未收到有效列表时手柄不可拖拽，订阅失败显示具体错误。TCP 链含有控制器不接收的关节时拒绝规划并提示检查 TCP link。
- 正运动学和逆解保留 TCP 链上的 fixed joint 与工具偏移；控制器负责但不在 TCP 链上的关节保持当前反馈，其他反馈关节不进入轨迹且不被预览改写。反馈位置缺失、非有限值或关节名重复时拒绝规划，不以零补齐。拖拽期间预览位姿不被实时 JointState 覆盖。
- 松开鼠标时按最新 JointState 重算一次并下发 `trajectory_msgs/msg/JointTrajectory`：第 1 点为当前反馈位置（短暂停留），第 2 点为目标位置，执行时长按最大关节位移在 0.4–6 s 内估算。
- 下发失败或 IK 未收敛时把模型恢复到反馈位姿并在视图内展示原因，不隐藏失败。
- 松手下发前再次校验当前 active 控制器的关节集合与顺序；JointState 或控制器反馈超过 1 秒、尚未收到反馈或实时显示暂停时拒绝下发。Bridge ACK 表示消息已发布，不代表控制器已接受或机械臂已执行完成。
- Bridge 只向以 `/joint_trajectory` 结尾且仅含字母数字下划线斜杠的 Topic 发布，并要求该 Topic 已有订阅者；关节名重复、点数/长度不一致、非有限数值以及非严格递增的 `time_from_start` 都会被拒绝。

## 12. 全局工具栏、诊断与 rosbag

- 点位运动抖动可使用 Jetson 独立只读脚本 `scripts/motion_diagnostics/monitor_motion.py` 采集与离线分析：保留完整遥测、规划/执行结果、发布者与源/接收时间，按动作统计误差、速度、sequence 与指令间隔。脚本不发送控制指令；Ctrl+C 仅停止采集。启动与数据边界见 [运动诊断](./motion-diagnostics)。

- “暂停显示”只冻结 WebView 对 Topic、JointState 和硬件状态消息的消费，不断开 Bridge，也不停止后台 rosbag；恢复后从下一条消息继续更新。
- “全部刷新”同时刷新 Topics 和 ROS Control 列表，并复用各自的并发保护。
- “开始录制”通过受约束的 Tauri SSH 命令在 Jetson 执行 `ros2 bag record -a`，输出到 `$HOME/robot-console-bags/robot-console-<时间>`；PID 和输出路径记录在 `$HOME/.cache/robot-console/`。停止时先发送 SIGINT 以便 rosbag 完成索引，超时后才使用 SIGTERM。
- rosbag PID 在停止和状态检查前同时验证进程存在且命令行为 `ros2 bag record`，避免对复用 PID 的无关进程发送信号。断开 Rebotarm Debug Desk 不会自动停止录制；重新连接会恢复显示远端录制状态。
- “诊断快照”保存本机 JSON，包含脱敏后的连接信息、Topics、Controller、micro-ROS Agent、HardwareStatus、选中 Topic 和消息统计；不写入 SSH 私钥路径，大消息预览限制为 4 KiB，文件上限为 5 MiB。
- “重置布局”恢复 Topics 页默认左右宽度、Topics/ROS Control 分割比例并展开侧栏和数据面板；“设置”可配置自动刷新周期和诊断快照是否包含消息摘要。

## 13. 单元测试覆盖矩阵

| 功能域 | 覆盖内容 | 测试位置 |
|---|---|---|
| 配置 | 默认值、损坏数据回退、旧路径/Topic 迁移 | `src/appLogic.test.ts` |
| 面板 | 默认/持久化状态、三个内容面板与左右侧栏收起、宽高分隔条和尺寸边界、已连接工具条与 Status 卡片的网格区域隔离 | `src/appLogic.test.ts`、`src/layoutLogic.test.ts`、`src/App.test.tsx`、`src/styles.test.ts` |
| 工具栏 | 导航职责分离、中心局部 Tab（Robot View / Topic Graph / 位置）、全部刷新、实时暂停/恢复、连接配置、设置和布局重置 | `src/App.test.tsx`、`src/toolbarLogic.test.ts`、`src/PositionPage.test.tsx` |
| rosbag/诊断 | 安全命令生成、PID/状态解析、录制启停、诊断脱敏/预览上限/文件校验与导出 | `src-tauri/src/lib.rs`、`src/toolbarLogic.test.ts`、`src/App.test.tsx` |
| 连接流程 | SSH→会话→Bridge→Agent、状态灯/步骤/可读错误/最近主机、JointState 冒烟、实际端口、基础订阅、重连会话数据清理、版本检查与升级提示 | `src/App.test.tsx`、`src/appLogic.test.ts`、`src/bridge.test.ts` |
| Agent | systemd 属性解析、异常 PID、restart 命令 | `src-tauri/src/lib.rs` |
| Status / 日志 | 四 Tab 汇总、键盘/故障跳转、互斥模式与安全门、日志搜索/跟随/下载、轮询并发与会话隔离、文件轮转/来源白名单/大小限制 | `src/statusLogic.test.ts`、`src/StatusPage.test.tsx`、`src/ControlLogViewer.test.tsx`、`src/controlLogLogic.test.ts`、`src-tauri/src/control_logs.rs`、`src-tauri/tests/test_control_logs.py`、`src-tauri/src/lib.rs` |
| SSH 输入 | 用户名目标、setup 路径和 Topic 格式校验 | `src-tauri/src/lib.rs` |
| 本地端口 | 首选端口及占用时自动回退 | `src-tauri/src/lib.rs` |
| Topic | 发现、选择订阅、消息路由、计数和频率、手动/30 秒自动刷新 | `src/App.test.tsx`、`src/appLogic.test.ts` |
| Topic Graph | ROS 图请求、无边界力导向布局、保留斜杠的 20 字符标签、选中后的画布平移、边界外节点拖动及刷新保留位置、Fit/Reset、占位粒子流速、Bridge 过滤、Controller 聚焦、节点订阅和刷新 | `src/bridge.test.ts`、`src/topicGraphLogic.test.ts`、`src/TopicGraph.test.tsx`、`src/App.test.tsx` |
| Inspector | Topic/Node 详情、完整 Topic 名称、JSON 右键字段、图像预览、订阅失败提示 | `src/TopicInspector.test.tsx`、`src/App.test.tsx` |
| 数据采集 | Navigation 入口、配置校验与持久化、Episode 启动/保存/丢弃/结束、并发与旧响应、SSH 参数安全、进程身份、续录检查、正常 finalize | `src/DataCollectionPage.test.tsx`、`src/dataCollectionLogic.test.ts`、`src/AppNav.test.tsx`、`src/App.test.tsx`、`src-tauri/src/data_collection.rs`、`src-tauri/tests/test_collection_remote.py` |
| Monitor / DataGraph | Dashboard/Panel CRUD、Inspector 两级加入、Panel 多序列与四类图表、布局预设（localStorage + JSON 导入导出）、网格拖拽、共享准星、bag `/clock`/stamp 时间轴、播放条（暂停/1x/进度估算）、暂停跟随/冻结窗口、最大化、重置/锁定/紧凑、v1→v2 迁移、转矩 7 Panel、30s 窗口、Jetson bag play | `src/TopicInspector.test.tsx`、`src/monitorLogic.test.ts`、`src/monitorChartLogic.test.ts`、`src/MonitorChart.test.tsx`、`src/monitorTimeline.test.ts`、`src/MonitorPage.test.tsx`、`src/dataGraphLogic.test.ts`、`src/DataGraph.test.tsx`、`src/App.test.tsx`、`src-tauri` rosbag play 测试 |
| 图像 Topic | Image WebSocket 二进制全速传输、动画帧合并绘制、RGB/BGR/RGBA/BGRA/Mono8/Mono16 转换、step/大小端、Canvas 预览及紧凑元数据 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`bridge/easy_debug_bridge/test/test_image_topic.py`、`src/bridge.test.ts`、`src/imageTopicLogic.test.ts`、`src/RosImagePreview.test.tsx`、`src/TopicInspector.test.tsx` |
| 通用 Topic 解码 | 已安装消息类型的嵌套字段、数组、时间与大整数，ControllerState Inspector 路由、错误类型拒绝 | `bridge/easy_debug_bridge/test/test_topic_json.cpp`、`bridge/easy_debug_bridge/test/test_generic_topic.py`（ROS 集成）、`src/App.test.tsx` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Controller 状态展示、Activate/Deactivate、操作后刷新、手动/30 秒自动刷新 | `src-tauri/src/lib.rs`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | transient-local 晚加入 QoS、symlink-install package URI 与目录穿越防护、相对纹理、Base64、JointState 映射、内联/命名材质颜色、异步网格挂载后着色、错误/轨迹提示非重叠布局 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`src/urdfLogic.test.ts`、`src/ViewerHeadsUp.test.tsx`、`src/resourceCacheLogic.test.ts`、`src/urdfAssetLogic.test.ts`、`src/UrdfViewer.test.tsx`、`bridge/easy_debug_bridge/test/test_viewer_transport.py` |
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
