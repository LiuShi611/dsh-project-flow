# 上架材料

给 `awesome-dsh-plugin` 提 PR 用。作者：刘适。

---

## 一、收录条目

文件路径：`data/plugins/LiuShi611__dsh-project-flow.yml`

文件名和 `url` 里的仓库地址必须完全一致。

```yaml
url: https://github.com/LiuShi611/dsh-project-flow
name: LiuShi611/dsh-project-flow
category: workflow
description:
  en: "Five-stage workflow that turns one long task into intent, plan, build, self-check and a report against the original requirements, with the middle three stages in isolated child agents; every stage retries on its own and carries a deadline, an interrupted run resumes from the artifacts on disk, and each build attempt gets a snapshot before and after so a bad result can be rolled back wholesale or per file."
  zh: "把一个大任务拆成问意图、规划、实施、自检、按原始要求验收五段，中间三段各开独立子会话、只传任务书；单段异常自动重试并带截止时间，进程中断后按磁盘产物续跑，每次实施前后各打一张快照，跑废了可整棵回滚或只还原那一轮动过的文件。"
icon: https://raw.githubusercontent.com/LiuShi611/dsh-project-flow/main/assets/icon-180.png
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

已经全部按 `LiuShi611` 填好了：条目文件名、`url`、`icon`、package.json 的 `repository` / `homepage` / `bugs`、README 的安装命令。如果这个账号名不对，整包搜一遍替换，漏一处链接就断。

**2. 建仓库并推代码**

公开仓库，加 `dsh-plugin` topic。仓库要创建满 1 天才能过 CI，这一项是自动检查的。

**3. 改 package.json**

两处要确认：

- `"private"` 已经改成 `false`。
- `license` 现在是 `"PolyForm-Small-Business-1.0.0"`，SPDX 标准标识，指向包根目录的许可全文。**不要改回 MIT**——MIT 允许无限规模的商业使用和再销售，和你要的门槛冲突。

**3.5 许可与免责（已配好，说明一下为什么这样写）**

- [LICENSE](LICENSE) 是 PolyForm Small Business License 1.0.0 原文，没有改动一个字，只在文件头加了一行 `Required Notice: Copyright © 2026 刘适 (Liu Shi)` 和一句指向 `docs/COMMERCIAL.md` 的中文说明。原文不能改，这是这份许可的规矩。
- `package.json` 的 `license` 字段是 SPDX 标识 `PolyForm-Small-Business-1.0.0`。GitHub、npm、各种 SCA 工具都认得，公司采购看到这个标识不用请律师重审。
- 门槛是这份许可自带的：员工加外包合计少于 100 人、上一财年收入低于 100 万美元（按 CPI 调整）的公司，商业用途也算允许。超过这个规模才需要商业授权。
- 商业授权的价位、流程、联系方式在 [COMMERCIAL.md](COMMERCIAL.md)。这份文档的作用是让过门槛的公司知道「去哪、多少钱、多久回」，不然条款写了等于没写。
- 运行时也会显示：`project_models` 和 `/flow-models` 各多一行许可提示，系统提示词段落末尾也带上。用户跑 `/flow-models` 就会看到，不会只在 LICENSE 里躺着。
- 代码文件头、README、docs 三处都加了警示。

**注意**：市场列表的收录规则没有限制许可类型，PolyForm 不影响收录。条目描述里要提许可就据实写。

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

- 要不要发 npm

GitHub 账号名已经按 `LiuShi611` 填好，`"private": true` 已经改成 `false`，许可是 PolyForm Small Business 1.0.0，免责与门槛都在 LICENSE 全文里并在运行时显示。

联系方式是 2479465655@qq.com，价位是小团队 2,000 / 中型 8,000 / 大型 20,000 起，都在 `docs/COMMERCIAL.md` 里。

## 六、许可定下来之后要注意的一件事

`package.json` 的 `license` 字段是 `"PolyForm-Small-Business-1.0.0"`，SPDX 标识，npm 与 GitHub 都认。

许可一旦以某个版本发布出去，那个版本就永远适用当时声明的许可，改不回来。这个插件还没公开，现在是唯一的定许可窗口。**一旦推上去并发了 npm，之后想放宽或收紧，只能对新版本生效，老版本管不着。**

所以推之前先想清楚两件事：

1. 门槛要不要调整。PolyForm 的门槛（100 人 / 100 万美元）是写死在许可原文里的，改动就变成自写许可，SPDX 也认不出来了。想换门槛就换许可，别改原文。
2. 商业授权那份文档里的价位是不是你真敢报的数。现在定的是各档下限（2,000 / 8,000 / 20,000），报出去就难改。第一次谈的时候按这个数来；如果第一个客户觉得便宜，下一版再调，已经签的那份不动。

市场列表本身对许可没有要求，PolyForm 不影响收录。条款拦不住明文 JS，实际执行靠事后追，但给了 32 天整改期，比「一违就断」好谈得多。
