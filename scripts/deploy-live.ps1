# deploy-live.ps1 — 已弃用（v0.2.0 起）
#
# 旧版"免重启热部署"方案依赖别名包（dsh-cache-cost-monitor-live）绕过模块缓存，
# 但该方案弱化了 bundle 规范（别名包不含 dsh.bundle 声明），且新版本 DSH 启动
# 校验更严格，不再适用。
#
# 请改用规范安装方式：
#   powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
# 或手动执行：
#   dsh plugin --profile web add <本目录绝对路径>
# 修改代码后重新 `npm run build` 并重启 DSH 生效。
