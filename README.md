# 智能车手机控制台

在线地址：<https://epochhit.github.io/smart-car-controller/>

面向 STM32F103 + JDY-31-SPP 的手机优先调试网页。默认通过 Web Serial 连接经典蓝牙 SPP，并发送带换行的 ASCII 文本命令；同时保留 `FFE0 / FFE1` BLE 连接作为备用。

## JDY-31 连接

1. Android 系统蓝牙中先配对 JDY-31。
2. 使用 Android Chrome 137 或更高版本打开在线地址。
3. 保持连接方式为“JDY-31 / HC-05（SPP）”，点击“连接”，在浏览器列表中选择已配对的设备。

Chrome 桌面版 117 起也支持配对后的蓝牙 SPP。Android Edge 是否开放 Web Serial 取决于其版本，因此手机调试以 Chrome 为准。HC-05 与 JDY-31 一样是经典蓝牙 SPP，不是 BLE，换成 HC-05 不会提升网页 BLE 兼容性。

## 功能

- 遥控、传感器台架和待机模式互斥。
- SPP 模式只列出标准蓝牙串口设备；首次授权且仅有一个 SPP 端口时，可直接连接上次设备。
- BLE 备用模式可按设备名称前缀过滤，默认 `JDY`；Web Bluetooth 不提供 MAC 地址过滤。
- XY 摇杆：Y 控制前进/倒车速度，X 控制左右差速；纯前后自动启用直线外环。
- 摇杆中心死区外从最低稳定 CPS 映射到方向上限，避免把低到无法维持的指令直接交给电机。
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

默认最低稳定值取目前最低已验证的 3900 CPS，前进/倒车上限为 4300 CPS；摇杆 50%约对应 4070 CPS，而不是上限的一半。速度 PI 会根据编码器反馈自动计算 PWM，`SPEED_MAX_PCT` 只是允许的输出上限。调参页可按 +5% / +10% 整体提高四个方向目标并保留左右比例。

必须烧录与本网页协议匹配的最新 `car_main.hex`。旧固件不认识 `JOY`、`TURN90`、`ENC RESET` 和前后分开的轮速参数。

## 平台说明

JDY-31 / HC-05 的网页连接目标平台是 Android Chrome；iPhone 上的 Chrome/Safari 不能用这一网页入口连接经典蓝牙 SPP。以后若换成真正的 BLE UART 模块，可选择网页中的 `BLE（FFE0 / FFE1）` 入口。
