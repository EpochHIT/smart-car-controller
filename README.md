# 智能车手机控制台

在线地址：<https://epochhit.github.io/smart-car-controller/>

面向 STM32F103 + JDY 蓝牙模块的手机优先调试网页。使用 `FFE0 / FFE1`，发送带换行的 ASCII 文本命令。

## 功能

- 遥控、传感器台架和待机模式互斥。
- 前后左右、全局停车、原闭环直线命令。
- 左右轮独立 PWM 开环测试。
- HC-SR04 实时距离、左右扫描距离和建议方向。
- SG90 手动角度、左/中/右预设与自动扫描。
- 左右独立目标 CPS、速度 PI、直线修正、超声波和舵机参数调节。
- 暂存、应用并写入 Flash、取消暂存。
- 自动采样 `TRACE` / `SENSOR`，导出带实验备注的 CSV 日志。
- XY 摇杆保留为后续模块，当前不发送命令。

## 页面结构

首屏只放蓝牙连接、运行模式和停车；其余功能分为四个标签：

1. **遥控**：方向、闭环直行、左右独立 PWM 和关键诊断数据。
2. **传感**：距离、舵机与自动扫描。
3. **调参**：折叠的速度、直线和传感器参数。
4. **日志**：单次/连续采样和 CSV 导出。

## 主要命令

| 功能 | 命令 |
| --- | --- |
| 模式 | `MODE STANDBY` / `MODE REMOTE` / `MODE SENSOR` |
| 遥控 | `FORWARD` / `BACKWARD` / `LEFT` / `RIGHT` / `STOP` |
| 独立 PWM | `PWM <左0–100> <右0–100>` |
| 直线快照 | `TRACE` |
| 传感器快照 | `SENSOR` |
| 手动舵机 | `SERVO <0–180>` |
| 恢复自动扫描 | `SERVO AUTO` |
| 参数 | `CHECK` / `SET <参数> <整数>` / `APPLY` / `CANCEL` |

必须烧录与本网页协议匹配的最新 `car_main.hex`，旧固件不认识 `TRACE`、`SENSOR`、`SERVO` 和左右独立目标 CPS。

## iPhone

普通 Safari 无法直接调用 Web Bluetooth 时，可在 Bluefy 中打开上方 HTTPS 地址，再从网页选择 JDY 设备。
