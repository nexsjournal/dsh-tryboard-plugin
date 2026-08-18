#!/usr/bin/env bash
#
# 把 dsh-tryboard-plugin 安装进一个 DSH profile（等价于：
#   dsh plugin --profile <name> add -w <spec>
# 其中 <spec> 可以是本插件目录（link: 软链安装，适合本地开发，改动即时生效）、
# 一个 npm 包名/版本，或一个 GitHub 仓库（git+https://...，首次安装需联网）。
#
# 用法：
#   ./scripts/install.sh                 # 安装本目录到 web profile（默认）
#   ./scripts/install.sh --profile web   # 指定 profile
#   ./scripts/install.sh git+https://github.com/<你>/dsh-tryboard-plugin.git
#
# 注意：profile 的 package.json 是 pnpm workspace 根，add 必须带 -w，
# 否则 pnpm 报 ERR_PNPM_ADDING_TO_ROOT。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

PROFILE="web"
SPEC="$PLUGIN_DIR"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      [ -n "$PROFILE" ] || { echo "install: --profile 需要一个值" >&2; exit 2; }
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    -*)
      echo "install: 未知选项 $1" >&2
      exit 2
      ;;
    *)
      SPEC="$1"
      shift
      ;;
  esac
done

command -v dsh >/dev/null 2>&1 || { echo "install: 找不到 dsh 命令，请确认 DeepSeek Harness 已安装且 dsh 在 PATH 中" >&2; exit 1; }

echo ">>> dsh plugin --profile ${PROFILE} add -w ${SPEC}"
dsh plugin --profile "$PROFILE" add -w "$SPEC"
echo
echo "✅ 已安装到 ${PROFILE} profile。"
echo "   请重启 DSH 一次（api-proxy 白名单补丁在下次启动生效）；"
echo "   之后点击侧边栏「看板」（设置上方）即可使用工作看板。"
