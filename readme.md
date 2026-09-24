# Checkin

GitHub Actions 实现 [GLaDOS][glados] 自动签到

([GLaDOS][glados] 可用邀请码: `MW4DK-O0RSF-C7AOU-EN1MP`, 双方都有奖励天数)

## 使用说明

1. Fork 这个仓库

1. 登录 [GLaDOS][glados] 获取 Cookie

1. 添加 Cookie 到 Secret `GLADOS`

1. 启用 Actions, 每天北京时间 00:10 自动签到

1. 如需推送通知, 可用 [PushPlus][pushplus], 添加 Token 到 Secret `NOTIFY`

## 结果判定

GLaDOS 在 Cookie 失效/未授权时**依然返回 HTTP 200**, 响应体为 `{"code":-2,"message":"没有权限"}`。
因此绝不能靠 HTTP 状态码或「有没有抛异常」判断成败, 只能看响应体里的 `code`：

| code | 含义 | 通知标题 | Actions |
| --- | --- | --- | --- |
| `0` | 签到成功 | 签到成功 ✅ | 绿色 |
| `1` | 今日已签到 | 今日已签到（重复执行） | 绿色 |
| `-2` | Cookie 失效 | 签到失败 ❌ Cookie 已失效 | **红色** |
| 其他 | 未知错误 | 签到失败 ❌ (code=…) | **红色** |

签到失败时进程退出码为 1, Actions 会变红, 不会再出现「提示成功但其实没签到」的情况。

> **Cookie 有效期有限**（通常一个月左右, 且仓库连续 60 天无提交时 Actions 定时任务会被自动暂停）。
> 一旦收到「签到失败 ❌ Cookie 已失效」的推送, 请重新登录 GLaDOS 抓取 Cookie 并更新 Secret `GLADOS`。

[glados]: https://github.com/glados-network/GLaDOS
[pushplus]: https://www.pushplus.plus/
