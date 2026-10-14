<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-gid-flow-title" aria-describedby="rdd-gid-flow-desc">
    <p id="rdd-gid-flow-title" class="rdd-diagram__title">重力辨识 · 职责与会话流（设计草案）</p>
    <p id="rdd-gid-flow-desc" class="rdd-diagram__sr">
      Desk 发 StartGravityID；ros2-stack 编排激励与拟合；executor 仅 meas 加 HOLD。
      Abort 或超时立即 HOLD；断开走既有 DISABLE。
    </p>

    <div class="rdd-panels rdd-panels--3" aria-hidden="true" style="margin-bottom:0.75rem">
      <div class="rdd-panel rdd-panel--nav">
        <p class="rdd-panel__title">robot-debug-desk</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">UI · Goal / Feedback / Result</div>
          <div class="rdd-panel__item">ARMED · Start / Abort</div>
          <div class="rdd-panel__item">禁 Motor / TCP 于运行中</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--center">
        <p class="rdd-panel__title">rebotarm-ros2-stack</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">/StartGravityID 编排</div>
          <div class="rdd-panel__item">姿态 · 拟合 · YAML</div>
          <div class="rdd-panel__item">热加载 GravityCompensation</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--side">
        <p class="rdd-panel__title">rebotarm-executor</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">meas · JointState</div>
          <div class="rdd-panel__item">HOLD / TRACK 命令</div>
          <div class="rdd-panel__item">fault → HOLD</div>
        </div>
      </div>
    </div>

    <div class="rdd-steps" aria-hidden="true">
      <div class="rdd-step rdd-step--accent">
        <strong>ARMED + Start</strong>
        <small>proposed: gravity_id_send_goal</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step">
        <strong>ARMING → ARMED</strong>
        <small>互斥控制器 · 夹爪锁</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--warn">
        <strong>(MOVING → SETTLE → CAPTURE)×N</strong>
        <small>Feedback: phase · pose · residual</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--ok">
        <strong>FITTING → WRITING → DONE</strong>
        <small>Result · yaml_path · Apply</small>
      </div>

      <div class="rdd-branch rdd-branch--2" style="margin:0.35rem 0">
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label rdd-branch__label--no">Abort / fault / 超时</span>
          <div class="rdd-step rdd-step--danger">
            <strong>ABORTING → HOLD</strong>
            <small>不自动 DISABLE</small>
          </div>
        </div>
        <div class="rdd-branch__arm">
          <span class="rdd-branch__label">Desk 断开</span>
          <div class="rdd-step rdd-step--danger">
            <strong>cancel + 既有 DISABLE</strong>
            <small>与 Motor 断开会话一致</small>
          </div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      不要弱化电机安全门。辨识会话依赖 command-loss → HOLD；Desk 不得在会话中停发所需链路心跳以外的危险命令流。
    </p>
  </figure>
</template>
