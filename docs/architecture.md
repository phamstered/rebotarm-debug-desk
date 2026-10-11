# Architecture

## Data path

```text
React/Three.js
      │ Tauri invoke
Rust SSH session manager
      │ local port forwarding
      ▼
Jetson 127.0.0.1:8765
Robot Console ROS Bridge
      │ rclcpp / Fast DDS
      ▼
ROS 2 Humble graph (including entities exposed by Micro XRCE-DDS Agent)
```

The desktop never joins DDS directly. SSH provides authentication, host-key verification and transport encryption. The Bridge is loopback-only.

## Connection sequence

1. Desktop checks `ssh` in batch mode.
2. Desktop sources `/opt/ros/humble/setup.bash`, the configured robot overlay, and the Bridge overlay.
3. Desktop starts the Bridge if its configured loopback port is not listening.
4. Desktop starts `ssh -N -L` local forwarding.
5. WebView opens a WebSocket to the local forwarded port.
6. UI requests Topic discovery and the node/topic endpoint graph, then subscribes to URDF and JointState topics.
7. Topic Graph applies Sugiyama-style barycentric sweeps before rendering publisher → topic → subscriber SVG edges. Selecting a Topic creates a read-only Bridge subscription and opens it in Topic Inspector.
8. Topic Inspector shows raw JSON by default. A non-empty per-Topic jq expression lazy-loads jq 1.8.2 inline WASM and filters each decoded sample locally.
9. Tauri polls `ros2 control list_controllers -c /controller_manager` over SSH every 30 seconds and shows controller names, types and states below Topics.
10. With an active `JointTrajectoryController`, the Robot View shows a draggable TCP handle. A drag solves position-only IK against the URDF joint chain; releasing it publishes `trajectory_msgs/JointTrajectory` to the controller's `~/joint_trajectory` topic through the Bridge.

## URDF assets

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, canonicalizes the path, rejects directory traversal and returns base64 bytes. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.

## Current limits

- One desktop session profile at a time.
- Bridge subscriptions are shared by all connected WebSocket clients.
- Message decoding uses an explicit standard-type registry.
- Mesh transfer is base64 and held in memory; streaming is a later optimization.
- Time-series Topic charts, TF and rosbag are not part of this vertical slice.
- Topic Graph can visualize every discovered type, while live jq inspection is limited to message types decoded by the Bridge registry.
- ROS Control targets `/controller_manager` and supports controller Activate/Deactivate. Trajectory commands only reach the active `JointTrajectoryController`'s `~/joint_trajectory` topic; the Bridge rejects any other topic.
- TCP dragging solves position only and keeps the end-effector orientation fixed.
