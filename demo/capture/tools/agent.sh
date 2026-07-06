#!/bin/sh
# Demo agent-lookalike ticker — endless, sanitized, phone-width (<=44 cols).
# NOT a real agent: scripted output that reads like one for preview cards.
C="\033[36m"; G="\033[32m"; M="\033[35m"; D="\033[2m"; B="\033[1m"; R="\033[0m"
O="\033[38;5;208m"
printf "${O}✻${R} ${B}agent${R} ${D}· workspace tour${R}\n\n"
printf "${D}>${R} walk the repo and draft a refactor plan\n\n"
i=0
while true; do
  i=$((i+1))
  case $((i % 16)) in
    0)  printf "${G}●${R} Read ${D}README.md${R}\n";;
    1)  printf "  ${D}⎿  38 lines${R}\n";;
    2)  printf "\n${C}✻ Thinking…${R}\n\n";;
    3)  printf "  The server keeps one room per\n";;
    4)  printf "  session; presence rides the same\n";;
    5)  printf "  socket as terminal frames.\n\n";;
    6)  printf "${G}●${R} Read ${D}server/rooms.ts${R}\n";;
    7)  printf "  ${D}⎿  112 lines${R}\n";;
    8)  printf "  Rooms elect a size owner — the\n";;
    9)  printf "  latest typer wins, so phones\n";;
    10) printf "  never fight the desktop.\n\n";;
    11) printf "${G}●${R} Grep ${D}\"presence\" · 9 matches${R}\n";;
    12) printf "  Next: split usePresence into\n";;
    13) printf "  transport + view-model layers,\n";;
    14) printf "  then add reconnect backoff.\n\n";;
    15) printf "${M}◐${R} ${D}streaming…${R}\n";;
  esac
  sleep 0.8
done
