# A connector cell: one of the user's apps as a program (an MCP server over stdin and stdout), run
# read-only as the image's unprivileged node user. npx and uvx fetch the program into the scratch
# home; the only way out is keyd, through the cell's gate.
FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2
RUN apk add --no-cache python3 uv ca-certificates
COPY entry.sh /usr/local/bin/connector-entry
USER node
ENTRYPOINT ["/usr/local/bin/connector-entry"]
