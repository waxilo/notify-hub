---
version: alpha
name: notify-hub-clean-white
description: |
  Notify Hub 控制台的「纯白画布 · 极浅灰层级（Clean White）」设计系统。
  画布就是一张干净的白纸（#ffffff），没有任何氛围层：
  层级由「白 → 极浅灰」的面阶梯 + 墨色发丝描边 + 一道将将看得见的柔投影表达。
  blur 只留在两处 —— 顶栏薄壳与模态遮罩，因为只有这两处真的有内容从身后穿过。
  文字是近黑墨色，字号与间距完全复用「极简 · 精密」那一套模数；强调色仍然只有一支信号橙。
based_on: 上一版 notify-hub-glassmorphism（去掉极光与玻璃，材质回到实心面）
---

## 三条纪律

1. 颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效时长一律走令牌，组件里不写裸值；
2. 强调色只有一支（信号橙），只出现在「当前态 / 焦点圈 / 关键数字」这类 10% 的位置；
3. 层级靠「面阶梯 + 发丝线 + 柔投影」，**不靠氛围层，也不靠 blur**。

## Colors

```yaml
canvas:
  base: "#ffffff"           # 页面底色：纯白，一块到底
  ink: "#101113"            # 近黑：主按钮、登录展示板
  ink-2: "#26282c"

surface:                    # 面阶梯 —— 层级 = 离白底有多远（越凹越灰、越抬越白）
  g1: "#ffffff"             # 大面板：纯白 + 一圈发丝描边 + 柔投影
  g2: "#f3f5f8"             # 次级小面（徽标底、内嵌块）
  g3: "#ffffff"             # 抬起面（按钮、模态、悬浮面板）—— 靠描边与投影立起来
  g4: "#ffffff"             # 焦点 / 选中
  shell: "rgba(255, 255, 255, .86)"   # 顶栏薄壳：唯一需要半透的贴内容面
  dark: "#17181c"           # 实心深色：吐司、登录展示板

surface-inner:              # 面板**内部**的分层：只用极浅灰浓淡，一律不 blur
  band: "#fafbfc"           # 头栏 / 页签条这类内嵌带
  card: "#f8f9fb"  card-hover: "#f1f3f7"       # 卡片区：静置是凹进去的灰槽
  row: "#f3f5f8"  row-on: "#eaf0f8"            # 行 hover / 选中（配左侧橙色指示轨）
  input: "#f7f8fa"  input-hover: "#f1f3f7"  input-focus: "#ffffff"
  groove: "#edeff3"         # 凹槽：分段控件、导航轨道
  inset: "#f5f6f9"          # 暗槽：代码块
  veil: "#fafbfc"           # 空态这类"几乎看不见"的面

edges:
  hairline:        "rgba(16, 17, 19, .1)"    # 白底上的面板描边就靠这一档
  hairline-soft:   "rgba(16, 17, 19, .06)"   # 行分隔
  hairline-strong: "rgba(16, 17, 19, .18)"   # hover / 复选框描边
  sheen:      "inset 0 1px 0 rgba(255, 255, 255, .9)"    # 浅灰面上的一道极淡顶光
  sheen-soft: "inset 0 1px 0 rgba(255, 255, 255, .7)"
  sink:       "inset 0 1px 2px rgba(30, 27, 60, .07)"    # 凹陷：输入槽、代码槽、导航轨道
  on-dark:    "rgba(255, 255, 255, .12)" / ".18"          # 深色面上的底与边
  wash:       "橙 / 绿各两档浓淡（.13 / .05）+ 焦点圈 0 0 0 3px rgba(255,90,31,.16)"

type:
  text: "#16181b"
  muted: "#5c6169"          # 白底 6.4:1
  mute-2: "#787e87"         # 仅占位符等非正文场景
  accent: "#ff5a1f"
  accent-ink: "#a83309"

state:
  ok: "#0a6e4e"
  warn: "#8a5300"
  danger: "#b3261e"
  info: "#3e4c63"
```

## Effects

| 层级 | 处理 | 用在 |
|---|---|---|
| 不透明（主锚点） | 实心 `--ink` | 主按钮 |
| 容器 | `--g1` 纯白 + `--line` 描边 + `--sh-2` | 分栏面板、登录卡 |
| 内嵌带 | `--g-band` / `--g-inset` + `--sink` | 头栏、页签条、代码块 |
| 灰槽 | `--g-card` + `--line-soft` 描边 + `--sink` | 卡片静置态 |
| 抬起 | `--g3` 白 + `--line` 描边 + `--sh-1` | 按钮、选中行、hover 卡片 |
| 凹槽 + 滑块 | `--g-groove` + `--sink` 轨道，内嵌白药丸 `--g4` + `--sh-1` | 顶栏导航、分段控件 |
| 半透薄壳 | `--g-shell` + `--blur-shell` | 顶栏（内容从身后滚过） |
| 遮罩 | `--mask` + `--blur-mask`，模态本体实心白 + `--sh-3` | 确认弹层 |
| 深色面 | 实心 `--g-dark`（自带网格与光雾装饰层） | 登录展示板、吐司 |

```yaml
shadow:
  sh-1: "var(--sheen), 0 1px 2px rgba(16,17,19,.06), 0 6px 16px -10px rgba(16,17,19,.14)"   # 小抬起
  sh-2: "var(--sheen), 0 1px 3px rgba(16,17,19,.06), 0 14px 34px -18px rgba(16,17,19,.2)"   # 容器
  sh-3: "0 2px 8px rgba(16,17,19,.1), 0 32px 64px -24px rgba(16,17,19,.3)"                  # 模态 / 吐司
  sh-flat: "0 1px 2px rgba(16,17,19,.18)"   # 实心近黑块（主按钮）
blur:
  shell: "saturate(1.6) blur(18px)"   # 顶栏
  mask:  "blur(8px)"                  # 模态遮罩
```

## Rounded

圆角沿用拟态那一版放大后的一档，不改：`xs 6 / sm 10 / md 14 / lg 18 / xl 26 / pill 999`。

## Typography & Spacing

**不变。** 沿用 Instrument Sans + IBM Plex Mono 的 1.25 字阶与 `--sp-1…--sp-7` 间距梯度。
换底色不换骨架 —— 这是这一版最重要的约束，布局契约（`.split.drill` / `.split.flow`、
sticky 左栏、44px 命中区）一个像素都没动。

## Rules（改这块代码时必须遵守）

- **blur 只剩两处**：顶栏薄壳与模态遮罩。贴在白底上的面板不许糊 —— 纯色背景后面没有东西可糊，
  `backdrop-filter` 只剩 GPU 开销。`tools/verify-ui.mjs` 直接断言整页 blur 元素数 === 1（弹层未开时）。
- 面板轮廓由 `--line` 这一档墨线承担，投影只负责"离开纸面"。把描边调没之前，先确认投影够不够。
- 层级顺序固定：`白容器 → 灰内嵌带 → 更灰的槽 → 抬起时回到白 + 投影`。
  同一个面上不要既给灰底又给重投影，那会读成"脏"。
- 主按钮保持实心近黑（唯一"压得住"的动作锚点），只在 hover 时加一层极淡的白内高光。
- 停用条目用斜纹底 + 褪色名称表达，选中条目用浅蓝灰底 + 左侧橙色实心轨 ——
  状态永远不只靠明度差，弱视也要分得清。
- 文字对比度：`--muted` 保持 `#5c6169`（白底 6.4:1）。验收脚本的合成对比度探针当前最低 4.62:1，阈值 4.5。
- 降级：这一版面阶梯本来就是实心的，所以 `@supports not (backdrop-filter: blur(1px))` 与
  `@media (prefers-reduced-transparency: reduce)` 都只需要处理 `--g-shell`（转实心白）与
  `--mask` / blur（关掉），不再需要整套令牌覆盖。
- 移动端（≤720px）只把 `--blur-shell` 降到 `blur(10px)`；顶栏导航轨道退回朴素条带
  （药丸轨道在这个宽度会被横向滚出可视区），当前项靠自己"浮起"表达。
