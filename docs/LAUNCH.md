# 上架材料

给 `awesome-dsh-plugin` 提 PR 用。作者：刘适。

---

## 一、收录条目

文件路径：`data/plugins/<你的GitHub名>__dsh-project-flow.yml`

把 `<你的GitHub名>` 换成实际的，文件名和 `url` 里的仓库地址必须完全一致。

```yaml
url: https://github.com/<你的GitHub名>/dsh-project-flow
name: <你的GitHub名>/dsh-project-flow
category: workflow
description:
  en: "Five-stage workflow that turns one long task into intent, plan, build, self-check and a report against the original requirements, with the middle three stages in isolated child agents; every stage retries on its own and carries a deadline, an interrupted run resumes from the artifacts on disk, and each build attempt gets a snapshot before and after so a bad result can be rolled back wholesale or per file."
  zh: "把一个大任务拆成问意图、规划、实施、自检、按原始要求验收五段，中间三段各开独立子会话、只传任务书；单段异常自动重试并带截止时间，进程中断后按磁盘产物续跑，每次实施前后各打一张快照，跑废了可整棵回滚或只还原那一轮动过的文件。"
icon: https://raw.githubusercontent.com/<你的GitHub名>/dsh-project-flow/main/assets/icon-180.png
```

分类选 `workflow`（工作流与自动化）。

### 描述里每一句都能对上代码

他们的评审会拿描述逐句核代码，所以我把对应关系列在这，方便你自己核对，也方便被问到时回答：

| 描述里说的 | 代码里的位置 |
|---|---|
| 五段、按原始要求验收 | `PLANNER_PROMPT` / `CHECKER_PROMPT` 都带上 `requirements` 列表；`05-report.md` 交接验收 |
| 中间三段独立子会话、只传任务书 | `runStage` 里 `ctx.subagents.startActivation`，`delivery: 'caller'`，跑完 `dispose()` |
| 单段异常自动重试 | `runStage` 的 `retries` 循环，`maxStageRetries` 默认 2 |
| 带截止时间 | `stageDeadline` + `stageTimeoutMs` 默认 900000 |
| 中断后续跑 | `project_resume` 读 `02-plan.md` / `03-build-*.md` / `03-correction-*.md` |
| 每次实施前后打快照 | `snap('实施前 R…')` 和 `snap('实施后 R…')` |
| 整棵回滚或只还原那轮动过的 | `project_rollback` 的 `mode: "full"` / `"precise"` |

工具数量也对得上：8 个（`project_run`、`project_resume`、`project_doctor`、`project_snapshots`、`project_rollback`、`project_status`、`project_models`、`project_set_model`），7 个斜杠命令。描述里没写具体数字，被问到再答。

---

## 二、发布前检查清单

按顺序做，前面不做完后面会白费。

**1. 定 GitHub 账号名**

条目文件名、`url`、`icon`、package.json 的 `repository` / `homepage` / `bugs`、README 的安装命令，全都要填这个。现在这些位置都是 `[GITHUB_USERNAME]` 占位。

**2. 建仓库并推代码**

公开仓库，加 `dsh-plugin` topic。仓库要创建满 1 天才能过 CI，这一项是自动检查的。

**3. 改 package.json**

三处要动：

- `"private"` 已经改成 `false`。
- 把 `[GITHUB_USERNAME]` 换成实际账号名（`repository` / `homepage` / `bugs` 四处）。
- `license` 现在是 `"SEE LICENSE IN LICENSE"`，指向包根目录的非商业许可全文。**不要改回 MIT**——MIT 允许商业使用和再销售，和你要的限制冲突。

**3.5 许可与免责（已配好，说明一下为什么这样写）**

- [LICENSE](<D:\dsh-plugins\dsh-project-flow\LICENSE>) 是自定义非商业许可，中英双语，中文为准。禁止商业用途（含企业内部部署）、禁止非法用途，附完整免责与终止条款。
- `package.json` 的 `license` 字段用 `SEE LICENSE IN LICENSE`。npm 和 SPDX 都没有「禁止商用」的标准标识，硬写 `MIT` 或 `CC-BY-NC` 都表达不准，所以指向全文最稳。
- 运行时也会显示：`project_models` 和 `/flow-models` 各多一行许可提示，系统提示词段落末尾也带上。用户跑 `/flow-models` 就会看到，不会只在 LICENSE 里躺着。
- 代码文件头、README、docs 三处都加了警示。

**注意**：市场列表的收录规则没有限制许可类型，非商业许可不影响收录。但如果条目描述里要提许可，据实写就好。

**4. 确认本地装的那份同步了**

源码在 `D:\dsh-plugins\dsh-project-flow`，profile 里是复制品，不是软链。改完源码要跑 `sync.ps1`。

**5.（可选但推荐）发 npm**

发 npm 的用户装的时候跳过构建授权那一步，体验好一截。发了还能在市场里显示下载量。不发也行，收录不受影响。

发了的话，`package.json` 里的 `repository` 必须指回这个 GitHub 仓库，否则两边关联不上。发完别急着提交，先确认 `registry.npmjs.org/<包名>` 里 `dist-tags.latest` 等于你发的版本，**并且** `dist.tarball` 真能下载——`npm publish` 打印成功不代表当时就装得上。

**6.（可选）发 GitHub Release tarball**

不发 npm 的话，建议把预构建 tgz 传一个到 Release，然后在条目里加 `tarball:` 指过去。**资产文件名别带版本号**，用 `latest/download/` 时文件名是照字面取的，带版本号的链接在你下次发版当天就 404。

**7. 提 PR**

一个 PR 只能加 1 条（上限 3 条），只改你自己那个 yml 文件，不要手改 README——那两个 README 是脚本从 `data/plugins/*.yml` 生成的，手改会让 PR 冲突。

---

## 三、可能被问到的三个点

先想好怎么答，省一轮往返。

**「这个和 dsh-goalloop-agentteams 有什么区别？」**

那个是目标完成门控：拦的是「模型假称做完了」，靠重跑检查命令验证。这个插件不判断活干得对不对，它管的是流程怎么组织：谁规划、谁实施、谁挑毛病、跑崩了怎么接上、跑废了怎么退回。两者可以一起用。

**「回滚为什么要 git？为什么不自己做文件备份？」**

自己做备份要么全量复制（大目录受不了），要么只备份报告过的文件（漏报就漏回滚）。git 的裸仓库加 `--work-tree` 能用增量存储，还能精确到「哪个文件新增、修改、删除」。快照仓库放在 `.project-flow/<项目>/snap.git`，不在用户工作区里 `git init`，不产生用户没要求的提交。

**「三段各用不同模型，会不会有一段偷偷回退了？」**

会，而且这是设计如此。指定的模型没被授权时不崩，退回当前模型继续跑，并在返回结论里写明哪一段回退了、为什么。要用 `project_models` 查实际生效的模型。

---

## 四、宣传用的短文案

### 一句话（市场列表用，已放进 yml）

> 把一个大任务拆成问意图、规划、实施、自检、按原始要求验收五段，中间三段各开独立子会话、只传任务书。

### 一段话（社交媒体 / 群里发）

> 我用 DSH 跑大任务总撞三个麻烦：上下文越跑越重、中途报错就得从头来、跑完了发现做错没退路。所以写了个插件 dsh-project-flow，把规划、实施、自检挪进独立子会话，只传任务书不传过程；进度全落磁盘，跑崩了从中断那段接着跑；每次实施前后自动打快照，跑废了能退回去，回错了还能再退。8 个工具、7 个斜杠命令，`/flow` 开一个就是了。

### 三个卖点（配图用）

1. **主对话只多一条结果**——中间三段跑完即弃，它们的读取和试错不进你的上下文。
2. **跑崩了不用从头来**——进度全在磁盘上，锁带进程号和心跳，死锁自动识别，从中断那段续跑。
3. **跑废了有退路**——每次实施前后各一张快照，整棵回滚或只还原那轮动过的文件，回滚前自动再存一张。

---

## 五、还需要你定的

- GitHub 账号名（我填进去，把 `[GITHUB_USERNAME]` 全部替换）
- 要不要发 npm

`"private": true` 已经改成 `false`，许可已经从 MIT 收紧为非商业，免责声明写进 LICENSE 全文并在运行时显示。

## 六、许可收紧后要注意的一件事

`package.json` 的 `license` 字段现在是 `"SEE LICENSE IN LICENSE"`。这符合 npm 规范，也是表达「非标准许可」的标准做法。

但要清楚：**开源许可一旦以 MIT 发布过就收不回来了**。这个插件目前还没公开，所以现在收紧是有效的。如果以后真发了 npm，之后想再改回更宽松或更严格的许可，已经发布出去的那些版本仍然适用当时声明的许可。

另外，市场列表本身对许可没有要求，非商业许可不影响收录。只是如果有人想在商业场景用，你的条款挡得住，但实际执行要靠你自己追。
