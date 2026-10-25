#!/bin/sh
# Container entrypoint: publish this build's static files, then run the server as PID 1 so it receives SIGTERM.
set -e
node deploy/publish-static.mjs
exec node --import tsx server/index.ts
