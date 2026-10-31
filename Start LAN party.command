#!/bin/sh
# Double-click to run AgentTown for a party on one network: npm run lan, in this
# folder. It finds this Mac's address, makes a director key and opens the
# director's view. See "On the day" in docs/HOST.md.
cd "$(dirname "$0")" || exit 1
stop() {
  echo
  echo "$1"
  echo "Press Return to close this window."
  read -r _
  exit 1
}
command -v node >/dev/null 2>&1 || stop "AgentTown needs Node.js 22 or later: https://nodejs.org"
if [ ! -d node_modules ]; then
  npm install || stop "npm install didn't work. See docs/TRY-IT.md, steps 1 and 2."
fi
trap : INT # Ctrl-C stops the town, not this window
npm run lan
stop "AgentTown has stopped."
