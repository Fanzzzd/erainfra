#!/usr/bin/env bash
set -euo pipefail

RC_HOME="$HOME/.runner-center"
META_FILE="$RC_HOME/install-meta"
LOG_FILE="$RC_HOME/agent.log"
START_SCRIPT="$RC_HOME/start-agent.sh"
PLIST="$HOME/Library/LaunchAgents/center.runner.agent.plist"
UNIT="$HOME/.config/systemd/user/runner-center-agent.service"
PID_FILE="$RC_HOME/agent.pid"

field() {
	grep "^$1=" "$META_FILE" 2>/dev/null | cut -d= -f2- | tail -n 1 || true
}

service_kind() {
	field SERVICE_KIND
}

stop_agent() {
	case "$(service_kind)" in
		launchd)
			launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
			;;
		systemd)
			systemctl --user stop runner-center-agent.service >/dev/null 2>&1 || true
			;;
		nohup)
			if [ -f "$PID_FILE" ]; then
				pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true)
				if [ -n "$pid" ]; then kill "$pid" >/dev/null 2>&1 || true; fi
				rm -f "$PID_FILE"
			fi
			;;
	esac
}

start_agent() {
	case "$(service_kind)" in
		launchd)
			launchctl bootstrap "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
			launchctl kickstart -k "gui/$UID/center.runner.agent"
			;;
		systemd)
			systemctl --user daemon-reload
			systemctl --user enable --now runner-center-agent.service
			systemctl --user restart runner-center-agent.service
			;;
		nohup)
			stop_agent
			nohup "$START_SCRIPT" >> "$LOG_FILE" 2>&1 </dev/null &
			printf '%s\n' "$!" > "$PID_FILE"
			;;
		*)
			printf '%s\n' 'Runner Center service metadata is missing. Run update from the dashboard install URL.' >&2
			exit 1
			;;
	esac
}

is_running() {
	case "$(service_kind)" in
		launchd) launchctl print "gui/$UID/center.runner.agent" 2>/dev/null | grep -q 'state = running' ;;
		systemd) systemctl --user is-active --quiet runner-center-agent.service ;;
		nohup)
			[ -f "$PID_FILE" ] && pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true) && [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
			;;
		*) return 1 ;;
	esac
}

usage() {
	printf '%s\n' 'Usage: rc status | logs [-f] | restart | stop | update | uninstall'
}

command='status'
if [ "$#" -gt 0 ]; then command=$1; fi
case "$command" in
	status)
		machine=$(field MACHINE_NAME)
		if is_running; then state='running'; else state='stopped'; fi
		last_line=$(tail -n 1 "$LOG_FILE" 2>/dev/null || true)
		printf 'Machine: %s\nStatus: %s\n' "$machine" "$state"
		if [ -n "$last_line" ]; then printf 'Last log: %s\n' "$last_line"; fi
		;;
	logs)
		follow=''
		if [ "$#" -ge 2 ]; then follow=$2; fi
		if [ "$follow" = '-f' ]; then
			touch "$LOG_FILE"
			tail -f "$LOG_FILE"
		else
			tail -n 100 "$LOG_FILE" 2>/dev/null || true
		fi
		;;
	restart)
		start_agent
		printf '%s\n' 'Runner Center agent restarted.'
		;;
	stop)
		stop_agent
		printf '%s\n' 'Runner Center agent stopped.'
		;;
	update)
		site=$(field SITE_URL)
		[ -n "$site" ] || { printf '%s\n' 'Runner Center site URL is missing.' >&2; exit 1; }
		curl -fsSL "$site/install" | bash -s -- --update
		;;
	uninstall)
		kind=$(service_kind)
		stop_agent
		if [ "$kind" = 'systemd' ]; then
			systemctl --user disable runner-center-agent.service >/dev/null 2>&1 || true
		fi
		rm -f "$PLIST" "$UNIT"
		if command -v systemctl >/dev/null 2>&1; then
			systemctl --user daemon-reload >/dev/null 2>&1 || true
		fi
		if command -v crontab >/dev/null 2>&1; then
			tmp=$(mktemp)
			(crontab -l 2>/dev/null || true) | grep -Fv "$START_SCRIPT" > "$tmp" || true
			crontab "$tmp" 2>/dev/null || true
			rm -f "$tmp"
		fi
		path_line='export PATH="$HOME/.runner-center/bin:$PATH" # runner-center'
		for shell_rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
			if [ -f "$shell_rc" ] && grep -Fq "$path_line" "$shell_rc"; then
				tmp=$(mktemp)
				grep -Fv "$path_line" "$shell_rc" > "$tmp" || true
				mv "$tmp" "$shell_rc"
			fi
		done
		rm -rf "$RC_HOME"
		printf '%s\n' 'Runner Center was removed. Delete the machine from the dashboard to remove its registration.'
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		exit 1
		;;
esac
