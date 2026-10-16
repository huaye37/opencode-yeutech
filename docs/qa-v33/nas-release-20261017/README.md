# 2026-10-17 NAS发布回执

## 结论
本目录是已经发生的发布与核验记录，不是再次部署指令。仅文档提交，不改变本轮已发布源码版本。

- agent: source `fd6dc0a2d304d45257d9cb7547ee62498ee68620`；镜像 `yeutech-agent:20261017-fix-fd6dc0a2d304`。
  - NAS备份 `/volume1/docker/yeutech-agent/backups/20261017-reviewed-fixes`；回滚脚本 `/volume1/docker/yeutech-agent/backups/20261017-reviewed-fixes/rollback.sh`。

## 发布实现
前五站以当前容器无暂停snapshot为基础，禁网构建覆盖已审查源码/产物，既有依赖与合法热补丁保留；Compose image/build引用同步为新版本。五站容器image ID与tag解析一致。
assistant保留原Python digest镜像和活动release，只覆盖frontend及maintenance.py/server.py并restart qinian-portal；release-manifest保留原sourceCommit，同时登记reviewedFixOverlay。
每站切换前核对任务空闲；备份、rollback snapshot和build context继续保留。没有修改代理、qinian-gateway、考研/robin、数据库或业务数据目录；受保护容器ID/image/StartedAt最终与首站发布前相同。
Agent从现有/projects挂载和唯一spaceId解析原NAS目录；仅补Compose环境变量，不移动或替换项目数据。

## 本次线上浏览器
Chrome现有登录态，2560×1262；只读关键路径验证。
真实bootstrap账号lucian显示首字母L；收起目录后从顶栏恢复展开，原搜索框获得焦点。截图中的9月17日旧会话失败记录不是本次运行错误；未发模型请求。
worklog、assistant、API本轮所采集warn/error日志为空；不把这一结果外推为全部站点全部历史日志为空。
静态CSS来自真实页面资源清单，原始字节与候选比对；每个站的production artifact实际含--yt-layer-*合同。JS等完整文件清单在容器内逐项校验；API额外公开HTTP校验app.js、nodes.mjs与合同runtime。

## 边界
- 本地全矩阵/外观边界测试是此前regression-20261017证据，本次线上只验证上述桌面关键路径；线上390×844、浅/深全矩阵和全部外观边界未重新跑。
- 未实测真实AI生成、批注写入、文稿采用、设备mutation、更新mutation、回滚执行或真机Safari；备份存在不等于已演练回滚。
- worklog没有schema/数据库写入，未运行db:verify；MySQL健康和真实列表读取已核验。
- 没有Git push、merge或作者验收声明。
- scripts是本次运维取证的历史脚本，不含凭证，也不是可无条件重放的通用发布器。NAS root-only备份中的old-service.json与环境文件不得复制入Git。
