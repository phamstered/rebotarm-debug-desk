<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-gid-wf-title" aria-describedby="rdd-gid-wf-desc">
    <p id="rdd-gid-wf-title" class="rdd-diagram__title">重力辨识 · UI 线框（设计草案）</p>
    <p id="rdd-gid-wf-desc" class="rdd-diagram__sr">
      独立页面：关节掩码复选框、安全 ARMED 门、Start/Abort、进度与残差、结果表与 Apply。
      Joint4 负载细标定作为可选子模式入口，不与本页主流程混用。
    </p>

    <div class="rdd-gid-wire" aria-hidden="true">
      <header class="rdd-gid-wire__bar">
        <span class="rdd-gid-wire__page">Navigation · 重力辨识</span>
        <span class="rdd-gid-wire__badge rdd-gid-wire__badge--warn">设计草案 · 未实现</span>
        <span class="rdd-gid-wire__link">可选子模式 → Joint4 标定</span>
      </header>

      <div class="rdd-gid-wire__grid">
        <section class="rdd-gid-card">
          <h4 class="rdd-gid-card__h">Goal · 参数</h4>
          <div class="rdd-gid-row">
            <span class="rdd-gid-label">joint_mask</span>
            <div class="rdd-gid-checks">
              <span class="rdd-gid-cb rdd-gid-cb--on">J1</span>
              <span class="rdd-gid-cb rdd-gid-cb--on">J2</span>
              <span class="rdd-gid-cb rdd-gid-cb--on">J3</span>
              <span class="rdd-gid-cb rdd-gid-cb--on">J4</span>
              <span class="rdd-gid-cb rdd-gid-cb--on">J5</span>
              <span class="rdd-gid-cb rdd-gid-cb--on">J6</span>
            </div>
          </div>
          <div class="rdd-gid-row">
            <span class="rdd-gid-label">mode</span>
            <span class="rdd-gid-pill rdd-gid-pill--accent">FULL_ARM_GRAVITY</span>
            <span class="rdd-gid-pill">PAYLOAD（→ Joint4）</span>
          </div>
          <div class="rdd-gid-row rdd-gid-row--meta">
            <span>settle 1.5 s · capture 1.0 s</span>
            <span>write_yaml · hot_reload</span>
            <span>lock_gripper ✓</span>
          </div>
          <div class="rdd-gid-row rdd-gid-row--meta">
            <span>max_effort / max_vel · command_timeout_ms</span>
          </div>
        </section>

        <section class="rdd-gid-card">
          <h4 class="rdd-gid-card__h">安全门 · 控制</h4>
          <div class="rdd-gid-armed">
            <span class="rdd-gid-armed__box">□ 安全确认 → confirmation: ARMED</span>
            <small>与 Motor 页同一会话门；辨识运行中禁用 Motor 滑块与 TCP 拖拽</small>
          </div>
          <div class="rdd-gid-actions">
            <span class="rdd-gid-btn rdd-gid-btn--ok">Start</span>
            <span class="rdd-gid-btn rdd-gid-btn--danger">Abort</span>
            <span class="rdd-gid-btn">Apply → GravityCompensation</span>
          </div>
          <p class="rdd-gid-hint">Abort / 超时 / 断开 → action cancel → 固件 HOLD；断开会话另走既有 DISABLE</p>
        </section>

        <section class="rdd-gid-card rdd-gid-card--wide">
          <h4 class="rdd-gid-card__h">Feedback · 进度与残差</h4>
          <div class="rdd-gid-progress">
            <div class="rdd-gid-phase">
              <strong>phase</strong>
              <span>PHASE_CAPTURING</span>
            </div>
            <div class="rdd-gid-phase">
              <strong>pose</strong>
              <span>pose_index 3 / pose_count 12</span>
            </div>
            <div class="rdd-gid-phase">
              <strong>fault</strong>
              <span>0 · FAULT_NONE</span>
            </div>
            <div class="rdd-gid-phase rdd-gid-phase--msg">
              <strong>message</strong>
              <span>capturing pose 3 · |residual| ok</span>
            </div>
          </div>
          <div class="rdd-gid-bars">
            <div class="rdd-gid-bar"><span>residual_nm</span><i style="width:42%"></i></div>
            <div class="rdd-gid-bar"><span>measured_effort</span><i style="width:58%"></i></div>
            <div class="rdd-gid-bar"><span>model_effort</span><i style="width:51%"></i></div>
            <div class="rdd-gid-bar"><span>rmse_running</span><i style="width:28%"></i></div>
          </div>
        </section>

        <section class="rdd-gid-card rdd-gid-card--wide">
          <h4 class="rdd-gid-card__h">Result · 辨识结果</h4>
          <div class="rdd-gid-table">
            <div class="rdd-gid-table__head">
              <span>joint</span><span>gravity_scales</span><span>torque_biases_nm</span><span>rmse</span>
            </div>
            <div class="rdd-gid-table__row"><span>J1</span><span>1.02</span><span>0.00</span><span>0.08</span></div>
            <div class="rdd-gid-table__row"><span>J2</span><span>0.98</span><span>0.05</span><span>0.10</span></div>
            <div class="rdd-gid-table__row"><span>J3</span><span>1.05</span><span>-0.02</span><span>0.09</span></div>
            <div class="rdd-gid-table__row"><span>J4</span><span>1.10</span><span>0.12</span><span>0.15</span></div>
            <div class="rdd-gid-table__row rdd-gid-table__row--muted"><span>…</span><span>—</span><span>—</span><span>—</span></div>
          </div>
          <div class="rdd-gid-result-meta">
            <span>rmse_total · 0.11</span>
            <span>yaml_path · ~/.rebotarm/gravity_id_latest.yaml</span>
            <span>success · true</span>
          </div>
        </section>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      Desk 只调 action；编排在 rebotarm-ros2-stack，HOLD/fault 在 rebotarm-executor。线框字段对齐 stack PR #12。
    </p>
  </figure>
</template>
