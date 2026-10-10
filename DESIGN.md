---
version: alpha
name: notify-hub-glassmorphism
description: |
  Notify Hub 控制台的「浅色毛玻璃拟态（Frosted Glass）」设计系统。
  画布是一片固定的极光渐变（信号橙 × 冷靛蓝 × 一点薄荷青），所有界面结构都浮在这层雾上：
  面板、卡片、输入框、弹层用半透白玻璃 + saturate blur + 上缘高光 + 冷紫投影表达层级，
  而不是靠底色深浅。文字仍然是近黑墨色，字号与间距完全复用「极简 · 精密」那一套模数，
  所以信息密度和可读性没有因为视觉变软而下降。强调色仍然只有一支信号橙。
based_on: design-md skill (apple 的 frosted sub-nav + vercel 的 mesh gradient 氛围层)
---

## 三条纪律（沿用上一版，只换材质）

1. 颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效时长一律走令牌，组件里不写裸值；
2. 强调色只有一支（信号橙），只出现在「当前态 / 焦点圈 / 关键数字」这类 10% 的位置；
3. ~~结构靠留白与发丝线分隔~~ → **结构靠玻璃层数 + 留白 + 发丝线**；底色深浅不再是层级手段。

## Colors

```yaml
canvas:
  base: "#eef1f6"            # 极光底下的冷白瓷面
  ink: "#101113"            # 近黑：主按钮、深色展示板
  ink-2: "#26282c"

aurora:                     # 氛围层：四束雾 + 一层颗粒，饱和度压低，只在边缘可感知
  warm:   "rgba(255, 90, 31, .28)"     # 品牌橙，左上 14% 8%
  cool:   "rgba(91, 140, 255, .26)"    # 冷靛蓝，右上 88% 14%
  violet: "rgba(150, 120, 255, .10)"   # 极淡紫，中部 46% 58%（只负责衔接，不参与配色叙事）
  mint:   "rgba(58, 214, 176, .14)"    # 薄荷青，底部 72% 108%
  veil:   "linear-gradient(180deg, #f3f5f9, #e7ebf3)"
  grain:  "feTurbulence fractalNoise, baseFrequency .9, opacity .14, tile 180px"  # 必须在极光之下、玻璃之后
  drift:  "body::after 62vw 圆斑 rgba(255,122,60,.22) + blur(48px)，26s alternate 只动 transform"

glass:                      # 玻璃阶梯：层级 = 不透明度 + 模糊半径，不是颜色深浅
  g1: "rgba(255, 255, 255, .46)"      # 大面板（左右分栏、登录卡片）
  g2: "rgba(255, 255, 255, .40)"      # 次级面（表头、内嵌区）
  g3: "rgba(255, 255, 255, .72)"      # 抬起面（按钮、弹层、悬浮面板）
  g4: "rgba(255, 255, 255, .88)"      # 焦点 / 选中态
  shell: "rgba(255, 255, 255, .58)"   # 顶栏这类贴内容的薄壳
  dark:  "rgba(16, 17, 19, .78)"      # 深色玻璃：吐司、登录展示板

glass-inner:                # 面板**内部**分层：只走 alpha，绝不叠第二层 blur
  band: ".30"  card: ".46"  card-hover: ".58"          # 内嵌带 / 卡片区
  row: ".42"   row-on: ".74"                           # 行 hover / 选中抬起
  input: ".5"  input-hover: ".66"  input-focus: ".92"  # 输入槽三态
  groove: "rgba(16,17,19,.055)"   # 凹槽：分段控件、导航轨道
  inset:  "rgba(16,17,19,.045)"   # 暗槽：代码块
  veil:   ".22"                   # 空态这类"几乎看不见"的面

edges:
  bd:        "rgba(255, 255, 255, .62)"  # 玻璃外描边（亮边）
  soft:      "rgba(255, 255, 255, .42)"
  strong:    "rgba(255, 255, 255, .84)"  # 弹层这类需要清晰轮廓的面
  hairline:  "rgba(16, 17, 19, .08)"     # 内容分隔仍用极淡墨线
  hairline-soft: "rgba(16, 17, 19, .06)" # 行分隔再淡一档
  hairline-strong: "rgba(16, 17, 19, .14)"
  sheen:     "inset 0 1px 0 rgba(255, 255, 255, .78)"   # 上缘镜面高光（玻璃的关键一笔）
  sheen-soft:"inset 0 1px 0 rgba(255, 255, 255, .6)"
  sink:      "inset 0 1px 2px rgba(30, 27, 60, .06)"    # 凹陷：输入槽、代码槽、导航轨道
  on-dark:   "rgba(255, 255, 255, .12)" / ".18"          # 深色玻璃上的面与边
  wash:      "橙 / 绿各两档浓淡（.13 / .05）+ 焦点圈 0 0 0 3px rgba(255,90,31,.16)"

type:
  text: "#16181b"
  muted: "#5c6169"          # 纸底 5.3:1 / 白玻璃 5.6:1，比旧值加深以守住玻璃上的对比度
  mute-2: "#787e87"
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
| 不透明 | 实心 `--ink`（+ hover 时极淡白内高光） | 主按钮 |
| 无 blur 的透明面 | 只走 `glass-inner` 的 alpha 阶梯 | 列表行、表格行、页签、面板内小块 |
| 薄壳 | `--g-shell` + `--blur-M` + `--glass-bd-soft` | 顶栏 |
| 一层玻璃 | `--g1` + 斜向镜面渐变 + `--blur-M` + `--glass-bd` + `--sh-2` | 分栏面板、登录卡片 |
| 二层玻璃 | `--g3` + `--blur-L` | 弹层、原始载荷悬浮面板 |
| 凹陷 | `--g-groove` / `--g-inset` + `--sink`（无 blur） | 分段控件轨道、导航轨道、代码块 |
| 深色玻璃 | `--g-dark` + `--blur-S`（吐司）/ `--blur-L`（登录展示板） + `--bd-on-dark` | 吐司、登录展示板 |

投影一律带冷紫底调（`rgba(30, 27, 60, …)`），不要用中性灰 —— 灰投影会让玻璃看起来脏。

```yaml
shadow:
  sh-1: "var(--sheen), 0 1px 2px rgba(30,27,60,.05), 0 8px 22px -14px rgba(30,27,60,.18)"   # 小抬起：按钮、选中行
  sh-2: "var(--sheen), 0 2px 4px rgba(30,27,60,.06), 0 18px 40px -18px rgba(30,27,60,.24)"  # 面板
  sh-3: "inset 0 1px 0 rgba(255,255,255,.9), 0 2px 8px rgba(30,27,60,.10), 0 40px 72px -28px rgba(30,27,60,.36)"  # 模态
  sh-flat: "0 1px 2px rgba(16,17,19,.18)"   # 降级路径 / 实心块
blur:
  S: "saturate(1.7) blur(16px)"
  M: "saturate(1.8) blur(22px)"
  L: "saturate(1.9) blur(28px)"
```

## Rounded

玻璃要有厚度感，圆角整体放大一档：`xs 6 / sm 10 / md 14 / lg 18 / xl 26 / pill 999`。

## Typography & Spacing

**不变。** 沿用 Instrument Sans + IBM Plex Mono 的 1.25 字阶与 `--sp-1…--sp-7` 间距梯度。
拟态只换材质，不换排版 —— 这是改版过程中最重要的约束。

## Rules（改这块代码时必须遵守）

- **模糊层数量有预算**：常态 3 层（顶栏 + 左右两块面板），弹层打开时 +2（遮罩 + 弹层本体），
  上限 5 —— `tools/verify-ui.mjs` 会数 `backdrop-filter !== none` 的元素并断言 ≤ 5。
  列表行、表格行、卡片内部小块 **绝不** 自己再套 blur —— 玻璃套玻璃只会糊成一片灰，还会掉帧。
- 玻璃面板**内部**的次级面用 `glass-inner` 那一组 alpha 表达（`.30 → .42 → .46 → .58 → .74 → .92`），
  靠浓淡分层，不靠 blur，也不靠底色深浅。
- 每块玻璃必须有：亮边 `--glass-bd` + 上缘 `--sheen` + 冷调投影。三件套缺一件就会看起来像一块糊掉的白框。
  大面板额外叠一层 168° 的斜向白色渐变做镜面反射，否则纯色玻璃在长页面上会显得"平"。
- 主按钮保持实心近黑（它是唯一「压得住」的动作锚点），只在 hover 时加一层极淡的白内高光。
- 颗粒噪点（`feTurbulence`）只能待在极光层里，**永远不要盖在内容上**；透明度超过 `.2` 就开始看起来脏。
- 文字在玻璃上必须重新核对比度：`--muted` 已从 `#63676d` 加深到 `#5c6169`，不要再调回去。
  验收脚本的对比度探针会把祖先元素的 alpha 合成后再算，当前最低值 5.25:1（阈值 4.5）。
- 降级双保险（两条分支共用同一组令牌覆盖，改一处必须改两处）：
  - `@supports not (backdrop-filter: blur(1px))` → 所有玻璃令牌转实心白瓷，blur 全部 `none`，停掉漂移光斑；
  - `@media (prefers-reduced-transparency: reduce)` → 同上，并把模态遮罩改成不透墨 + 关 blur；
  - `@media (prefers-reduced-motion: reduce)` 已全局关动效。
  - 覆盖里 `--sheen / --sheen-soft / --sink` 必须写成 `0 0 0 0 transparent` 而不是 `none`：
    它们会出现在 `box-shadow: var(--sheen), …` 的逗号序列里，`none` 会让整条声明失效。
- 移动端（≤720px）在媒体查询开头直接把 `--blur-M / --blur-L` 重映射成 `--blur-S`，
  顶栏导航轨道退回朴素条带（药丸轨道在窄屏会被横向滚出可视区）。
