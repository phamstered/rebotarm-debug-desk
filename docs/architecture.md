# Architecture

## Data path

```text
React/Three.js
      │ Tauri invoke
Rust SSH session manager
      │ local port forwarding
      ▼
Jetson 127.0.0.1:8765
Easy Debug ROS Bridge
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
6. UI requests the graph and subscribes to URDF and JointState topics.

## URDF assets

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, canonicalizes the path, rejects directory traversal and returns base64 bytes. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.

## Current limits

- One desktop session profile at a time.
- Bridge subscriptions are shared by all connected WebSocket clients.
- Message decoding uses an explicit standard-type registry.
- Mesh transfer is base64 and held in memory; streaming is a later optimization.
- Topic charts, TF and rosbag are not part of this first vertical slice.
