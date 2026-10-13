<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-cal-title" aria-describedby="rdd-cal-desc">
    <p id="rdd-cal-title" class="rdd-diagram__title">Joint4 标定 · 姿态采集循环</p>
    <p id="rdd-cal-desc" class="rdd-diagram__sr">
      托住并移到姿态 → Begin Pose → 撤手部支撑 → Capture Pose → 托住加 Release；
      重复至足够姿态后 Fit，再导出 JSON 或 CSV。结果不修改 URDF 或在线参数。
    </p>

    <div class="rdd-steps" aria-hidden="true">
      <div class="rdd-step rdd-step--accent">
        <strong>托住并移到姿态</strong>
        <small>急停可用 · Controller active</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step">
        <strong>Begin Pose</strong>
        <small>Trigger 服务</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--warn">
        <strong>撤手部支撑</strong>
        <small>待姿态稳定</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--ok">
        <strong>Capture Pose</strong>
        <small>稳定且支撑已撤</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step">
        <strong>托住 + Release</strong>
        <small>清除故障锁存</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--decision">
        <strong>还需姿态？</strong>
        <small>至少 4 · 推荐 6–8</small>
      </div>

      <div class="rdd-branch rdd-branch--2" style="margin:0.35rem 0">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label">是 → 回到起点</span>
          <div class="rdd-step rdd-step--muted">
            <strong>下一姿态</strong>
            <small>重复 Begin → Capture → Release</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--ok">否</span>
          <div class="rdd-step rdd-step--ok">
            <strong>Fit → 导出 JSON / CSV</strong>
            <small>只显示与导出 · 不改 URDF</small>
          </div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      Robot Debug Desk 不自动激活控制器；请在 Dashboard 的 ROS Control 面板显式操作。
    </p>
  </figure>
</template>
