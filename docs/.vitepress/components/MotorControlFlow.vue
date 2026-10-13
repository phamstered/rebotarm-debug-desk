<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-motor-title" aria-describedby="rdd-motor-desc">
    <p id="rdd-motor-title" class="rdd-diagram__title">MIT 电机控制 · 安全门与发送</p>
    <p id="rdd-motor-desc" class="rdd-diagram__sr">
      选择关节并使能后须安全确认；Bridge 预检 subscriber、反馈新鲜度与 active_joint_mask；
      通过后以 20 Hz 发送。停止并 DISABLE 始终可用。
    </p>

    <div class="rdd-steps" aria-hidden="true">
      <div class="rdd-step rdd-step--accent">
        <strong>选择关节并使能</strong>
        <small>Position 滑块 · 至少一轴使能</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--decision">
        <strong>安全确认？</strong>
        <small>同一连接会话内一次即可</small>
      </div>

      <div class="rdd-branch rdd-branch--2" style="margin:0.35rem 0">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--no">否</span>
          <div class="rdd-step rdd-step--danger">
            <strong>拒绝非 DISABLE</strong>
            <small>须先勾选安全确认</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--ok">是 → Bridge 预检</span>
          <div class="rdd-checks">
            <div class="rdd-check"><span class="rdd-check__q">?</span> command subscriber 存在？</div>
            <div class="rdd-check"><span class="rdd-check__q">?</span> 反馈新鲜（&lt; 1 s）？</div>
            <div class="rdd-check"><span class="rdd-check__q">?</span> 掩码 ⊆ active_joint_mask？</div>
          </div>
        </div>
      </div>

      <div class="rdd-branch rdd-branch--2">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--no">预检失败</span>
          <div class="rdd-step rdd-step--danger">
            <strong>拒绝并提示</strong>
            <small>展示具体失败原因</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--ok">预检通过</span>
          <div class="rdd-step rdd-step--ok">
            <strong>20 Hz 连续发送</strong>
            <small>/stm32/joint_commands</small>
          </div>
        </div>
      </div>

      <div class="rdd-step-arrow"><span>停机</span></div>
      <div class="rdd-step rdd-step--warn">
        <strong>停止并 DISABLE</strong>
        <small>始终可用 · 无需解锁 · 清零通道</small>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      最终执行安全由固件裁决；界面仅限制 Effort（|effort| ≤ 1 Nm）。
    </p>
  </figure>
</template>
