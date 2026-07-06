#!/bin/sh
# Demo deploy/metrics ticker — endless, sanitized.
G="\033[32m"; Y="\033[33m"; M="\033[35m"; D="\033[2m"; B="\033[1m"; R="\033[0m"
i=0
printf "${B}edge-deploy ${D}watching production${R}\n\n"
while true; do
  i=$((i+1))
  ts=$(date +%H:%M:%S)
  case $((i % 5)) in
    0) printf "${D}${ts}${R} ${M}render${R} p50=$((18 + i % 9))ms p99=$((61 + i % 22))ms\n";;
    1) printf "${D}${ts}${R} ${G}healthy${R} 12/12 instances ${D}us-east, eu-west, ap-south${R}\n";;
    2) printf "${D}${ts}${R} ${G}✓${R} cdn cache hit $((92 + i % 6)).$((i % 10))%%\n";;
    3) printf "${D}${ts}${R} ${Y}queue${R} depth=$((i % 4)) ${D}drained in $((3 + i % 5))s${R}\n";;
    4) printf "${D}${ts}${R} ${G}✓${R} rollout wave $((1 + i % 4))/4 complete\n";;
  esac
  sleep 1
done
