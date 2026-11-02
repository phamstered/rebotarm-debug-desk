cmake_minimum_required(VERSION 3.16)
project(easy_debug_bridge)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

find_package(ament_cmake REQUIRED)
find_package(ament_index_cpp REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_action REQUIRED)
find_package(std_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(tf2 REQUIRED)
find_package(tf2_ros REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(diagnostic_msgs REQUIRED)
find_package(trajectory_msgs REQUIRED)
find_package(shape_msgs REQUIRED)
find_package(rosidl_typesupport_introspection_cpp REQUIRED)
find_package(microros_stm32h723_bridge REQUIRED)
find_package(Boost REQUIRED COMPONENTS system thread)
find_package(ZLIB REQUIRED)
find_package(moveit_msgs QUIET)
find_package(control_msgs QUIET)
find_package(controller_manager_msgs QUIET)

add_executable(bridge_node src/bridge_node.cpp)
target_include_directories(bridge_node PRIVATE include)
ament_target_dependencies(bridge_node
  ament_index_cpp rclcpp rclcpp_action std_msgs sensor_msgs geometry_msgs nav_msgs diagnostic_msgs
  trajectory_msgs shape_msgs tf2 tf2_ros microros_stm32h723_bridge rosidl_typesupport_introspection_cpp)
target_link_libraries(bridge_node Boost::system Boost::thread ZLIB::ZLIB)
if(moveit_msgs_FOUND AND control_msgs_FOUND AND controller_manager_msgs_FOUND)
  target_sources(bridge_node PRIVATE src/position_motion.cpp)
  ament_target_dependencies(bridge_node moveit_msgs control_msgs controller_manager_msgs)
else()
  target_sources(bridge_node PRIVATE src/position_motion_unavailable.cpp)
  message(WARNING "MoveIt2 position execution disabled: optional ROS message packages unavailable")
endif()
# GravityIdentification client is gated in bridge_node.cpp via __has_include on
# microros_stm32h723_bridge/action/gravity_identification.hpp (stack PR #23).
# Without that header the binary still builds; gravity_id_* ops return a clear error.

install(TARGETS bridge_node DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY config/ DESTINATION share/${PROJECT_NAME}/config)

if(BUILD_TESTING)
  enable_testing()
  add_executable(test_bridge_core test/test_bridge_core.cpp)
  target_include_directories(test_bridge_core PRIVATE include)
  add_test(NAME bridge_core COMMAND test_bridge_core)
  add_executable(test_capture_core test/test_capture_core.cpp)
  target_include_directories(test_capture_core PRIVATE include)
  target_link_libraries(test_capture_core ZLIB::ZLIB)
  add_test(NAME capture_core COMMAND test_capture_core)
  add_executable(test_position_model test/test_position_model.cpp)
  target_include_directories(test_position_model PRIVATE include)
  add_test(NAME position_model COMMAND test_position_model)
  target_link_libraries(test_bridge_core ZLIB::ZLIB)
  add_executable(test_tcp_pose_core test/test_tcp_pose_core.cpp)
  target_include_directories(test_tcp_pose_core PRIVATE include)
  add_test(NAME tcp_pose_core COMMAND test_tcp_pose_core)
  add_executable(test_clock_sync_core test/test_clock_sync_core.cpp)
  target_include_directories(test_clock_sync_core PRIVATE include)
  add_test(NAME clock_sync_core COMMAND test_clock_sync_core)
  add_executable(test_tcp_pose_model test/test_tcp_pose_model.cpp)
  target_include_directories(test_tcp_pose_model PRIVATE include)
  add_test(NAME tcp_pose_model COMMAND test_tcp_pose_model)
  add_executable(test_topic_json test/test_topic_json.cpp)
  target_include_directories(test_topic_json PRIVATE include)
  ament_target_dependencies(test_topic_json rclcpp std_msgs trajectory_msgs rosidl_typesupport_introspection_cpp)
  add_test(NAME topic_json COMMAND test_topic_json)
  if(moveit_msgs_FOUND AND control_msgs_FOUND AND controller_manager_msgs_FOUND)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    add_test(NAME capture_action_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_capture_action_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(capture_action_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=219;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 120)
    add_test(NAME position_group_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_position_group_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(position_group_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=217;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 120)
    add_test(NAME gripper_motion_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_gripper_motion_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(gripper_motion_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=213;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 90)
    add_test(NAME clock_sync_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_clock_sync_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(clock_sync_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=215;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 120)
    add_test(NAME rgbd_stream_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_rgbd_stream_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(rgbd_stream_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=216;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 120)
    add_test(NAME controller_health_ros
      COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/test/test_controller_health_ros.py $<TARGET_FILE:bridge_node>)
    set_tests_properties(controller_health_ros PROPERTIES
      ENVIRONMENT "ROS_DOMAIN_ID=214;ROS_LOCALHOST_ONLY=1" RUN_SERIAL TRUE TIMEOUT 120)
  endif()
endif()
ament_package()
