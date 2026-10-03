# The brain cell (spec "brain cell"): one bundled Node program, run read-only as the image's
# unprivileged node user, with no shell work to do (the agent's commands run in the desktop).
# Build the bundle first: pnpm --filter @localdot/brain build (build.sh does both).
FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2
COPY dist/brain.mjs /opt/localdot/brain.mjs
USER node
ENTRYPOINT ["node", "/opt/localdot/brain.mjs"]
