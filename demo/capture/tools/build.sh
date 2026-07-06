#!/bin/sh
# Demo build/test ticker — endless, colorful, sanitized.
G="\033[32m"; Y="\033[33m"; C="\033[36m"; D="\033[2m"; B="\033[1m"; R="\033[0m"
i=0
printf "${B}vite build ${D}(watch mode)${R}\n\n"
while true; do
  i=$((i+1))
  ts=$(date +%H:%M:%S)
  case $((i % 6)) in
    0) printf "${D}${ts}${R} ${C}transform${R} src/components/RoomView.tsx\n";;
    1) printf "${D}${ts}${R} ${C}transform${R} src/hooks/usePresence.ts\n";;
    2) printf "${D}${ts}${R} ${G}✓${R} 128 modules transformed in $((180 + i % 140))ms\n";;
    3) printf "${D}${ts}${R} ${G}✓${R} dist/assets/index.js  ${D}142.5 kB │ gzip: 45.9 kB${R}\n";;
    4) printf "${D}${ts}${R} ${Y}hmr update${R} /src/styles.css\n";;
    5) printf "${D}${ts}${R} ${G}✓${R} tests: 47 passed ${D}(bells 12, election 9, switcher 26)${R}\n";;
  esac
  sleep 1
done
