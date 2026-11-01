<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-tcp-title" aria-describedby="rdd-tcp-desc">
    <p id="rdd-tcp-title" class="rdd-diagram__title">TCP 拖拽轨迹 · IK 与下发</p>
    <p id="rdd-tcp-desc" class="rdd-diagram__sr">
      需有 active JointTrajectoryController 才开放拖拽；逐帧 6D 位姿 IK，残差超过 5 mm 拒发；
      松手保留预览，确认后经 Bridge 校验并由 MoveIt 规划执行，可附带独立夹爪目标。
    </p>

    <div class="rdd-steps" aria-hidden="true">
      <div class="rdd-step rdd-step--decision">
        <strong>active JointTrajectoryController？</strong>
        <small>类型优先 · 名称含 traj 次之</small>
      </div>

      <div class="rdd-branch rdd-branch--2" style="margin:0.35rem 0">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--no">否</span>
          <div class="rdd-step rdd-step--muted">
            <strong>拖拽不开放</strong>
            <small>先在 ROS Control 激活</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--ok">是</span>
          <div class="rdd-step rdd-step--accent">
            <strong>拖拽 TCP 手柄</strong>
            <small>正交平面 · Esc 取消</small>
          </div>
        </div>
      </div>

      <div class="rdd-step-arrow"><span>拖拽中</span></div>
      <div class="rdd-step">
        <strong>逐帧 6D 位姿 IK</strong>
        <small>XYZ 平移 · RPY 旋转</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--decision">
        <strong>位置 ≤5 mm 且姿态 ≤0.02 rad？</strong>
      </div>

      <div class="rdd-branch rdd-branch--2" style="margin:0.35rem 0">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--no">否 / 校验失败</span>
          <div class="rdd-step rdd-step--danger">
            <strong>恢复反馈位姿并提示</strong>
            <small>展示残差或失败原因</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--ok">是</span>
          <div class="rdd-step rdd-step--ok">
            <strong>松手预览 → 确认执行</strong>
            <small>Bridge 安全门 → MoveIt 规划与执行</small>
          </div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      夹爪（joint7）使用 mm 行程输入；统一运动任务支持取消，Action 成功后再核对实测到位与停稳。
    </p>
  </figure>
</template>
