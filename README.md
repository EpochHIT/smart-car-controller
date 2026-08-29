# 智能车手机控制台

在线地址：<https://epochhit.github.io/smart-car-controller/>

面向 STM32F103 + JDY 蓝牙模块的手机优先调试网页。使用 `FFE0 / FFE1`，发送带换行的 ASCII 文本命令。

## 功能

- 遥控、传感器台架和待机模式互斥。
- XY 摇杆：Y 控制前进/倒车速度，X 控制左右差速；纯前后自动启用直线外环。
- 前进与倒车分别标定左右轮目标 CPS。
- 左转与右转分别标定 90°编码器计数，并可一键复现。
- 保留前后左右按键、`TRACE` 诊断，以及底层实际 PWM 显示；不提供绕过闭环的独立 PWM 遥控。
- HC-SR04 实时距离、左右扫描距离和建议方向。
- SG90 手动角度、左/中/右预设与自动扫描。
- 参数暂存、写入 Flash、取消暂存，以及 CSV 实验日志导出。

## 页面结构

1. **遥控**：摇杆和 90°转弯在前；按键与详细数据折叠收纳。
2. **传感**：距离、舵机与自动扫描。
3. **调参**：速度、直线修正、传感器参数。
4. **日志**：单次/连续采样和 CSV 导出。

## 主要命令

| 功能 | 命令 |
| --- | --- |
| 模式 | `MODE STANDBY` / `MODE REMOTE` / `MODE SENSOR` |
| 摇杆 | `JOY <X -100..100> <Y -100..100>` |
| 固定方向 | `FORWARD` / `BACKWARD` / `LEFT` / `RIGHT` / `STOP` |
| 90°转弯 | `TURN90 LEFT` / `TURN90 RIGHT` |
| 编码器清零/读取 | `ENC RESET` / `ENC` |
| 遥控快照 | `TRACE` |
| 传感器快照 | `SENSOR` |
| 手动/自动舵机 | `SERVO <0–180>` / `SERVO AUTO` |
| 参数 | `CHECK` / `SET <参数> <整数>` / `APPLY` / `CANCEL` |

摇杆的 100% 表示请求当前方向的目标 CPS，不表示直接输出 100% PWM。速度 PI 会根据编码器反馈自动计算 PWM，`SPEED_MAX_PCT` 只是允许的输出上限。

必须烧录与本网页协议匹配的最新 `car_main.hex`。旧固件不认识 `JOY`、`TURN90`、`ENC RESET` 和前后分开的轮速参数。

## iPhone

普通 Safari 无法直接调用 Web Bluetooth 时，可在 Bluefy 中打开上方 HTTPS 地址，再从网页选择 JDY 设备。
