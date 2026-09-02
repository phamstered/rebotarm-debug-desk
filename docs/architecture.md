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
6. UI requests Topic discovery and the node/topic endpoint graph, then subscribes to URDF, Robot View `/joint_states`, and motor-safety `/stm32/joint_states` topics independently.
7. Topic Graph applies Sugiyama-style barycentric sweeps before rendering publisher → topic → subscriber SVG edges. Selecting a Topic creates a read-only Bridge subscription and opens it in Topic Inspector.
8. Topic Inspector has Data, Topic Info and Publish tabs. Data shows raw JSON by default and lazy-loads jq 1.8.2 WASM only for a non-empty expression.
9. Topic Info and one-frame JSON publishing execute validated Humble CLI commands over SSH. Generic publishing explicitly rejects the configured motor command Topic.
10. Tauri polls `ros2 control list_controllers -c /controller_manager` over SSH every 30 seconds and shows controller names, types and states below Topics.

## URDF assets

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, canonicalizes the path, rejects directory traversal and returns base64 bytes. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.

## Current limits

- One desktop session profile at a time.
- Bridge subscriptions are shared by all connected WebSocket clients.
- Message decoding uses ROS 2 C++ introspection at runtime; the message package and its introspection typesupport must be installed in the Jetson environment.
- Mesh transfer is base64 and held in memory; streaming is a later optimization.
- Time-series Topic charts, TF and rosbag are not part of this vertical slice.
- Topic Graph can visualize every discovered type. Topic Inspector can decode every installed ROS message type, including custom, nested and array fields.
- ROS Control targets `/controller_manager` and supports controller Activate/Deactivate operations.
