# Read-only capability check. Do not stop, clean, launch or publish here.
[ -f "$ws/scripts/start_arm_teleop.sh" ] || {
    echo "拖动示教预检失败：找不到 $ws/scripts/start_arm_teleop.sh" >&2
    exit 1
}
grep -q -- '--mode=.*teaching' "$ws/scripts/start_arm_teleop.sh" || {
    echo "请升级 ROS 控制栈：缺少拖动示教支持" >&2
    exit 1
}
if teaching_help=$(timeout 10 ros2 run microros_stm32h723_bridge teaching_gripper.py --help 2>&1); then
    case "$teaching_help" in
        *check-manual*) ;;
        *) echo "请升级 ROS 控制栈：缺少手动夹爪示教支持" >&2; exit 1 ;;
    esac
else
    printf '手动夹爪示教预检失败：%s\n' "$teaching_help" >&2
    exit 1
fi
