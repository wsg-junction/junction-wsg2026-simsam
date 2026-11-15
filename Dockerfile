FROM node:26-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/models/package.json packages/models/
# On CRACI runners all HTTPS goes through CRACI's proxy and its CA certificate, which the
# job trusts but this build does not (npm fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE). CI
# passes the CA as the build secret "extra-ca"; Node is pointed at it for this step only.
# Without the secret (local builds, GitHub-hosted runners) nothing changes.
RUN --mount=type=secret,id=extra-ca,required=false sh -c 'if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; npm ci'

COPY . .
RUN npm run build -w web

# What is running: shown on the Health page.
ARG BUILD_SHA=
ARG BUILD_TIME=
ENV NODE_ENV=production PORT=3000 BUILD_SHA=$BUILD_SHA BUILD_TIME=$BUILD_TIME
EXPOSE 3000
CMD ["npm", "start", "-w", "api"]
