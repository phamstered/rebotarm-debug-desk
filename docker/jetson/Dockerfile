ARG STACK_IMAGE=rebotarm-stack:humble
FROM ${STACK_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /opt/easy_debug_bridge
COPY bridge/easy_debug_bridge/ src/easy_debug_bridge/
RUN apt-get update \
 && apt-get install -y --no-install-recommends libboost-system-dev libboost-thread-dev libpcl-dev libopencv-dev zlib1g-dev \
 && source /opt/ros/humble/setup.bash \
 && source /opt/rebotarm/install/setup.bash \
 && rosdep install --from-paths src --ignore-src -y --rosdistro humble --skip-keys microros_stm32h723_bridge \
 && colcon build --executor sequential --event-handlers console_direct+ --cmake-args -DCMAKE_BUILD_TYPE=Release \
 && rm -rf /var/lib/apt/lists/*
COPY docker/jetson/verify.sh /usr/local/bin/verify-bridge-runtime
COPY docker/jetson/entrypoint.sh /usr/local/bin/bridge-entrypoint
ENTRYPOINT ["/usr/local/bin/bridge-entrypoint"]
CMD ["ros2", "run", "easy_debug_bridge", "bridge_node"]
