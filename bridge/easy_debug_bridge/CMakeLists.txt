cmake_minimum_required(VERSION 3.16)
project(easy_debug_bridge)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

find_package(ament_cmake REQUIRED)
find_package(ament_index_cpp REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rcpputils REQUIRED)
find_package(rmw REQUIRED)
find_package(rosidl_runtime_cpp REQUIRED)
find_package(rosidl_typesupport_introspection_cpp REQUIRED)
find_package(std_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(trajectory_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(diagnostic_msgs REQUIRED)
find_package(microros_stm32h723_bridge REQUIRED)
find_package(Boost REQUIRED COMPONENTS system thread)

add_executable(bridge_node src/bridge_node.cpp src/generic_message.cpp)
target_include_directories(bridge_node PRIVATE include)
ament_target_dependencies(bridge_node
  ament_index_cpp rclcpp rcpputils rmw rosidl_runtime_cpp rosidl_typesupport_introspection_cpp
  std_msgs sensor_msgs trajectory_msgs geometry_msgs nav_msgs diagnostic_msgs
  microros_stm32h723_bridge)
target_link_libraries(bridge_node Boost::system Boost::thread)

install(TARGETS bridge_node DESTINATION lib/${PROJECT_NAME})

if(BUILD_TESTING)
  enable_testing()
  add_executable(test_bridge_core test/test_bridge_core.cpp)
  target_include_directories(test_bridge_core PRIVATE include)
  add_test(NAME bridge_core COMMAND test_bridge_core)
endif()
ament_package()
